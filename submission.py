"""Validate one workshop ZIP. The CLI and preview server share this validator."""

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import re
import stat
import struct
from zipfile import BadZipFile, ZipFile
from zlib import error as InflateError


ROOT = Path(__file__).resolve().parent
MIB = 1024 * 1024
MODEL_LIMIT = 20 * MIB
ZIP_LIMIT = 48 * MIB
IMAGE_TOTAL_LIMIT = 24 * MIB
CHANGES_LIMIT = 64 * 1024
REQUIRED = {"submission.json": 64 * 1024, "manifest.json": 64 * 1024, "model.glb": MODEL_LIMIT}
IMAGES = ("real-world", "model", "in-map")
IMAGE_PATH = re.compile(r"evidence/(real-world|model|in-map)(?:/[^/\\:\x00-\x1f]+)?\.(?i:png|jpg|jpeg)")
IMAGE_DIRECTORIES = {"evidence/"} | {f"evidence/{category}/" for category in IMAGES}


class Invalid(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise Invalid(code, message)


def object_json(data, name):
    def unique(pairs):
        result = dict(pairs)
        require(len(result) == len(pairs), "json", f"{name} 包含重复字段")
        return result

    def reject_constant(value):
        raise Invalid("json", f"{name} 包含无效数值 {value}")

    try:
        obj = json.loads(data.decode("utf-8-sig"), object_pairs_hook=unique, parse_constant=reject_constant)
    except (UnicodeError, ValueError) as error:
        raise Invalid("json", f"{name} 无效：{error}") from error
    require(isinstance(obj, dict), "json", f"{name} 必须是 JSON 对象")
    return obj


def number(value):
    return type(value) in (int, float) and -1e9 < value < 1e9


def vector(value, length):
    return isinstance(value, list) and len(value) == length and all(map(number, value))


def string(value):
    return isinstance(value, str) and bool(value.strip())


def safe_archive(archive):
    members, seen = {}, set()
    expanded = image_bytes = 0
    for member in archive.infolist():
        name = member.filename
        require(member.orig_filename == name and name not in seen
                and not stat.S_ISLNK(member.external_attr >> 16) and not member.flag_bits & 1,
                "zip_entry", f"ZIP 包含异常、加密或重复的条目：{name!r}")
        seen.add(name)
        if name in IMAGE_DIRECTORIES and member.is_dir() and not member.file_size:
            continue
        image = IMAGE_PATH.fullmatch(name)
        require(name in REQUIRED or name == "changes.md" or image,
                "zip_entry", f"ZIP 包含协议以外的条目：{name!r}")
        if image:
            image_bytes += member.file_size
            require(image_bytes <= IMAGE_TOTAL_LIMIT, "image_total_size", "所有图片合计超过 24 MiB")
        expanded += member.file_size
        require(expanded <= ZIP_LIMIT, "zip_size", "ZIP 展开后超过 48 MiB")
        members[name] = member
    require(REQUIRED.keys() <= members.keys(), "files", "缺少根目录必需文件：" +
            ", ".join(sorted(REQUIRED.keys() - members.keys())))
    for name, limit in REQUIRED.items():
        require(0 < members[name].file_size <= limit, "file_size", f"{name} 为空或超过大小上限")
    return members


def simple_polygon(ring):
    def turn(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    edges = list(zip(ring, ring[1:] + ring[:1]))
    for i, (a, b) in enumerate(edges):
        for j in range(i + 2, len(edges)):
            if i == 0 and j == len(edges) - 1:
                continue
            c, d = edges[j]
            if all(max(a[axis], b[axis]) >= min(c[axis], d[axis]) and
                   max(c[axis], d[axis]) >= min(a[axis], b[axis]) for axis in (0, 1)) and (
                turn(a, b, c) * turn(a, b, d) <= 0 and turn(c, d, a) * turn(c, d, b) <= 0
            ):
                return False
    return len(set(map(tuple, ring))) == len(ring)


def validate_model(data):
    require(len(data) >= 28, "glb", "GLB 文件不完整")
    magic, version, declared, json_size, json_kind = struct.unpack_from("<4sIII4s", data)
    bin_offset = 20 + json_size
    require(magic == b"glTF" and version == 2 and declared == len(data) and json_kind == b"JSON"
            and json_size % 4 == 0 and bin_offset + 8 <= len(data), "glb", "GLB 2.0 文件头或分块无效")
    bin_size, bin_kind = struct.unpack_from("<I4s", data, bin_offset)
    require(bin_kind == b"BIN\0" and bin_size % 4 == 0 and bin_offset + 8 + bin_size == len(data),
            "glb", "GLB 必须包含一个有效的内嵌二进制块")
    gltf = object_json(data[20:bin_offset], "GLB JSON")
    buffers, images = gltf.get("buffers"), gltf.get("images", [])
    require(isinstance(buffers, list) and len(buffers) == 1 and isinstance(buffers[0], dict)
            and "uri" not in buffers[0] and type(buffers[0].get("byteLength")) is int
            and 0 <= bin_size - buffers[0]["byteLength"] <= 3,
            "glb", "GLB 缓冲的长度无效或引用了外部资源")
    views = gltf.get("bufferViews", [])
    require(isinstance(views, list) and isinstance(images, list) and all(
        isinstance(image, dict) and "uri" not in image and type(image.get("bufferView")) is int
        and 0 <= image["bufferView"] < len(views) for image in images
    ), "glb", "GLB 贴图必须通过 bufferView 内嵌")
    for view in views:
        require(isinstance(view, dict) and view.get("buffer") == 0
                and type(view.get("byteLength")) is int and type(view.get("byteOffset", 0)) is int
                and view["byteLength"] > 0 and view.get("byteOffset", 0) >= 0
                and view["byteLength"] + view.get("byteOffset", 0) <= buffers[0]["byteLength"],
                "glb", "GLB bufferView 超出了内嵌缓冲")
    used = gltf.get("extensionsUsed", [])
    require(isinstance(used, list) and not any(
        extension in used for extension in ("KHR_draco_mesh_compression", "KHR_texture_basisu")
    ), "glb", "当前地图加载器未启用 Draco 或 KTX2 解码")
    meshes = gltf.get("meshes")
    require(isinstance(meshes, list) and any(isinstance(mesh, dict) and mesh.get("primitives") for mesh in meshes),
            "glb", "GLB 未包含可渲染网格")


def validate_metadata(submission, manifest, city, release):
    require(type(submission.get("schemaVersion")) is int and submission["schemaVersion"] == 1
            and type(manifest.get("schemaVersion")) is int and manifest["schemaVersion"] == 1,
            "schema", "两个清单的 schemaVersion 均须为 1")
    target, version = manifest.get("target"), manifest.get("version")
    require(isinstance(target, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", target)
            and isinstance(version, str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version),
            "identity", "目标 ID 或三段式模型版本无效")
    require(manifest.get("baseRevision") == city["revision"], "base_revision", "底图版本不匹配")
    require(all(place["id"] != target for place in city["landmarks"]), "target_conflict", "目标 ID 已被底图地标占用")

    def inside(point):
        x, z = point[:2]
        extent = city["extent"]
        return extent["minX"] <= x <= extent["maxX"] and extent["minZ"] <= z <= extent["maxZ"]

    placement = manifest.get("placement")
    require(isinstance(placement, dict), "placement", "缺少摆放参数")
    anchor, yaw, scale = (placement.get(key) for key in ("anchor", "yaw", "scale"))
    require(vector(anchor, 3) and inside(anchor) and abs(anchor[2]) <= 30 and number(yaw) and abs(yaw) <= 180
            and number(scale) and 0.1 <= scale <= 10, "placement", "锚点、高程偏移、朝向或比例无效")
    registered = next((place for place in release["targets"] if place["id"] == target), None)
    require(not registered or anchor[:2] == registered["point"], "placement", "锚点与已登记的目标不一致")
    scope = manifest.get("scope")
    require(isinstance(scope, list) and 1 <= len(scope) <= 32, "scope", "替换范围须为 1 到 32 个多边形")
    for ring in scope:
        require(isinstance(ring, list) and 3 <= len(ring) <= 32 and all(
            vector(point, 2) and inside(point) and math.dist(point, anchor[:2]) <= 500 for point in ring
        ), "scope", "替换多边形顶点无效或超出锚点 500 米")
        area = sum(x * v - z * u for (x, z), (u, v) in zip(ring, ring[1:] + ring[:1]))
        require(abs(area) >= 1, "scope", "替换多边形的面积过小")
        require(simple_polygon(ring), "scope", "替换多边形不可自交或包含重复顶点")

    place, rights, source = submission.get("place"), submission.get("rights"), manifest.get("source")
    require(isinstance(place, dict) and string(place.get("name")) and len(place["name"]) <= 100
            and vector(place.get("approachAt"), 2) and inside(place["approachAt"])
            and place["approachAt"] != anchor[:2] and number(place.get("height")) and 0 < place["height"] <= 300
            and ("description" not in place or isinstance(place["description"], str) and len(place["description"]) <= 200),
            "preview", "目标名称、模型高度或街景观察点无效")
    tile = [math.floor(value / city["tileSize"]) for value in place["approachAt"]]
    require(any(row[:2] == tile for row in city["tiles"]), "preview", "街景观察点没有底图街景分块")
    require(isinstance(rights, dict) and rights.get("basis") in ("original", "permission", "license")
            and string(rights.get("statement")), "rights", "需要一份作者授权、原创或许可声明")
    git = isinstance(source, dict) and string(source.get("repository")) and isinstance(source.get("commit"), str)
    require(isinstance(source, dict) and string(source.get("author")) and (
        git and re.fullmatch(r"[0-9a-f]{40}", source["commit"])
        or source.get("kind") in ("original", "adapted") and string(source.get("description"))
    ), "source", "请填写作者与仓库提交，或填写作品来源说明")
    return {"id": target, "name": place["name"], "en": place.get("description", ""), "point": anchor[:2],
            "approachAt": place["approachAt"], "height": place["height"], "active": version}


def evidence_score(archive, members):
    points = dict.fromkeys((*IMAGES, "changes"), False)
    warnings = []
    images = [(match[1], path) for path in members if (match := IMAGE_PATH.fullmatch(path))]
    if images:
        try:
            from PIL import Image
        except ImportError:
            warnings.append("图片未计分：需要 Pillow 才能验证图片")
            images = []

    for category, path in images:
        try:
            data = archive.read(members[path])
            with Image.open(io.BytesIO(data), formats=("PNG", "JPEG")) as image:
                expected = "PNG" if path.lower().endswith(".png") else "JPEG"
                if image.format != expected:
                    raise ValueError("扩展名与图像格式不符")
                image.verify()
            with Image.open(io.BytesIO(data), formats=("PNG", "JPEG")) as image:
                image.load()
            points[category] = True
        except (OSError, ValueError, BadZipFile, RuntimeError, InflateError, Image.DecompressionBombError) as error:
            warnings.append(f"{path} 未计分：{error}")
    if "changes.md" in members:
        try:
            member = members["changes.md"]
            if member.file_size > CHANGES_LIMIT:
                raise ValueError("超过 64 KiB")
            points["changes"] = bool(archive.read(member).decode("utf-8-sig").strip())
            if not points["changes"]:
                warnings.append("changes.md 为空")
        except (OSError, ValueError, BadZipFile, RuntimeError, InflateError) as error:
            warnings.append(f"changes.md 未计分：{error}")
    return points, warnings


def inspect_package(path):
    city = object_json((ROOT / "data/index.json").read_bytes(), "底图索引")
    release = object_json((ROOT / "data/replacements/index.json").read_bytes(), "发布清单")
    require(path.is_file() and path.stat().st_size <= ZIP_LIMIT, "zip_size", "ZIP 不存在或超过 48 MiB")
    with ZipFile(path) as archive:
        members = safe_archive(archive)
        submission = object_json(archive.read(members["submission.json"]), "submission.json")
        raw_manifest = archive.read(members["manifest.json"])
        manifest = object_json(raw_manifest, "manifest.json")
        place = validate_metadata(submission, manifest, city, release)
        model = archive.read(members["model.glb"])
        asset = manifest.get("asset")
        require(isinstance(asset, dict) and asset.get("file") == "model.glb" and type(asset.get("bytes")) is int
                and asset["bytes"] == len(model) and asset.get("sha256") == hashlib.sha256(model).hexdigest(),
                "checksum", "GLB 字节数或 SHA-256 不匹配")
        validate_model(model)
        published = ROOT / "data/replacements" / place["id"] / place["active"] / "manifest.json"
        if published.is_file():
            require(manifest == object_json(published.read_bytes(), "已登记版本清单"),
                    "version_conflict", "已登记的模型版本不可改写，请使用新版本号")
        points, warnings = evidence_score(archive, members)
    report = {"passed": True, "reviewScore": sum(points.values()), "maxScore": len(points),
              "evidence": points, "warnings": warnings, "target": place["id"], "version": place["active"]}
    return report, place, raw_manifest, model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    args = parser.parse_args()
    try:
        report, *_ = inspect_package(args.package)
    except Invalid as error:
        report = {"passed": False, "reviewScore": None, "error": {"code": error.code, "message": str(error)}}
    except (BadZipFile, OSError, RuntimeError, ValueError, RecursionError, InflateError) as error:
        report = {"passed": False, "reviewScore": None, "error": {"code": "package", "message": str(error)}}
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
