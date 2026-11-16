const directory = new URL("./data/replacements/", import.meta.url);
const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const maxAssetBytes = 20 * 1024 * 1024;

async function json(url) {
  const response = await fetch(url, { cache: "no-cache", redirect: "error" });
  if (!response.ok) throw new Error(`HTTP ${response.status} · ${url.pathname}`);
  return response.json();
}

const pair = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
const inside = ([x, z], extent) => x >= extent.minX && x <= extent.maxX &&
  z >= extent.minZ && z <= extent.maxZ;

function bounds(points) {
  const xs = points.map(point => point[0]);
  const zs = points.map(point => point[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

function covers(x, z, mask) {
  const { minX, maxX, minZ, maxZ, points } = mask;
  if (x < minX || x > maxX || z < minZ || z > maxZ) return false;
  let contained = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, az] = points[i], [bx, bz] = points[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) contained = !contained;
  }
  return contained;
}

function validPlace(place, extent) {
  return typeof place?.id === "string" && idPattern.test(place.id) &&
    typeof place.name === "string" && place.name.trim() &&
    pair(place.point) && inside(place.point, extent) && pair(place.approachAt) &&
    inside(place.approachAt, extent) && Number.isFinite(place.height) && place.height > 0 && place.height <= 300;
}

function validSource(source) {
  return typeof source?.author === "string" && source.author.trim() && (
    typeof source.repository === "string" && source.repository.trim() && /^[0-9a-f]{40}$/.test(source.commit) ||
    ["original", "adapted"].includes(source.kind) && typeof source.description === "string" && source.description.trim()
  );
}

async function loadRelease(place, version, index) {
  const folder = new URL(`${place.id}/${version}/`, directory);
  const manifest = await json(new URL("manifest.json", folder));
  const { schemaVersion, target, baseRevision, placement, scope, asset, source } = manifest;
  const valid = schemaVersion === 1 && target === place.id && manifest.version === version &&
    baseRevision === index.revision && placement?.anchor?.length === 3 &&
    placement.anchor.every(Number.isFinite) && placement.anchor[0] === place.point[0] &&
    placement.anchor[1] === place.point[1] && Math.abs(placement.anchor[2]) <= 30 &&
    Number.isFinite(placement.yaw) && Math.abs(placement.yaw) <= 180 &&
    Number.isFinite(placement.scale) && placement.scale >= 0.1 && placement.scale <= 10 &&
    asset?.file === "model.glb" && /^[0-9a-f]{64}$/.test(asset.sha256) &&
    Number.isInteger(asset.bytes) && asset.bytes > 20 && asset.bytes <= maxAssetBytes &&
    validSource(source) &&
    Array.isArray(scope) && scope.length > 0 && scope.length <= 32;
  if (!valid) throw new Error("模型、目标或底图版本无效");
  const masks = scope.map(points => {
    if (!Array.isArray(points) || points.length < 3 || points.length > 32 ||
        !points.every(point => pair(point) && inside(point, index.extent) &&
        Math.hypot(point[0] - place.point[0], point[1] - place.point[1]) <= 500)) {
      throw new Error("原建筑替换范围无效");
    }
    const twiceArea = points.reduce((area, [x, z], i) => {
      const [u, v] = points[(i + 1) % points.length];
      return area + x * v - z * u;
    }, 0);
    if (Math.abs(twiceArea) < 1) throw new Error("原建筑替换范围面积无效");
    return { ...bounds(points), points };
  });
  return { id: place.id, place, version, placement, masks, asset, url: new URL(asset.file, folder) };
}

export async function loadReplacements(index, enabled) {
  const places = [], models = [];
  try {
    const release = await json(new URL("index.json", directory));
    if (release.schemaVersion !== 1 || release.baseRevision !== index.revision || !Array.isArray(release.targets)) {
      return { places, models };
    }
    const ids = new Set(index.landmarks.map(place => place.id));
    const targets = release.targets.filter(place => {
      if (!validPlace(place, index.extent) || ids.has(place.id)) return false;
      ids.add(place.id);
      places.push(place);
      return enabled && typeof place.active === "string" && versionPattern.test(place.active);
    });
    const loaded = await Promise.allSettled(targets.map(place => loadRelease(place, place.active, index)));
    for (const result of loaded) {
      if (result.status === "fulfilled") models.push(result.value);
      else console.warn("模型替换清单无效", result.reason);
    }
  } catch (error) {
    console.warn("模型替换清单未加载", error);
  }
  return { places, models };
}

export async function readReplacement(model) {
  const response = await fetch(model.url, { redirect: "error" });
  const declared = response.headers.get("Content-Length");
  if (!response.ok || (declared !== null && Number(declared) !== model.asset.bytes)) {
    throw new Error("替换资源大小或响应状态不符");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(model.asset.bytes);
  let offset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.length > bytes.length) {
      await reader.cancel();
      throw new Error("替换资源超过声明大小");
    }
    bytes.set(value, offset);
    offset += value.length;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (offset !== bytes.length || Array.from(hash, value => value.toString(16).padStart(2, "0")).join("") !== model.asset.sha256) {
    throw new Error("替换资源 SHA-256 不匹配");
  }
  const header = new DataView(bytes.buffer);
  const jsonLength = header.getUint32(12, true);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 ||
      header.getUint32(8, true) !== bytes.length ||
      header.getUint32(16, true) !== 0x4e4f534a || jsonLength > bytes.length - 20) {
    throw new Error("替换资源须为 GLB 2.0");
  }
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  if ([...(gltf.buffers ?? []), ...(gltf.images ?? [])].some(entry => "uri" in entry)) {
    throw new Error("替换资源必须内嵌所有缓冲和贴图");
  }
  return bytes.buffer;
}

export function replacementAt(models, x, z) {
  return models.find(model => model.masks.some(mask => covers(x, z, mask)))?.id;
}

export function replacementsInTile(models, x, z, size) {
  return models.filter(model => model.masks.some(mask => mask.minX <= x + size &&
    mask.maxX >= x && mask.minZ <= z + size && mask.maxZ >= z));
}
