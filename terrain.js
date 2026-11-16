import * as THREE from "three";
import { OrbitControls } from "./vendor/examples/jsm/controls/OrbitControls.js";
import { paintBase } from "./map.js";
import { LandmarkLayer } from "./landmarks.js";
import { replacementAt, replacementsInTile } from "./replacements.js";

export async function fetchLocal(path, type = "json") {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error(`${path} · HTTP ${response.status}`);
  return response[type]();
}

export async function loadElevation() {
  const [meta, png] = await Promise.all([
    fetchLocal("./data/terrain.json"),
    fetchLocal("./data/terrain.png", "blob")
  ]);
  const bitmap = await createImageBitmap(png, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const { nx, nz, minX, minZ, cell } = meta;
  if (bitmap.width !== nx || bitmap.height !== nz || meta.encoding !== "rg16-decimetres") {
    bitmap.close();
    throw new Error("高程网格与说明文件不匹配");
  }
  const canvas = new OffscreenCanvas(nx, nz);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, nx, nz).data;
  const samples = new Int16Array(nx * nz);
  for (let i = 0; i < samples.length; i++) samples[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] - 32768;
  return (x, z) => {
    const gx = THREE.MathUtils.clamp((x - minX) / cell, 0, nx - 1);
    const gz = THREE.MathUtils.clamp((z - minZ) / cell, 0, nz - 1);
    const ix = Math.min(nx - 2, Math.floor(gx));
    const iz = Math.min(nz - 2, Math.floor(gz));
    const i = iz * nx + ix;
    const a = THREE.MathUtils.lerp(samples[i], samples[i + 1], gx - ix);
    const b = THREE.MathUtils.lerp(samples[i + nx], samples[i + nx + 1], gx - ix);
    return THREE.MathUtils.lerp(a, b, gz - iz) / 10;
  };
}

function makeGround(bounds, sampleHeight) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const divX = Math.ceil(width / 50);
  const divZ = Math.ceil(depth / 50);
  const geometry = new THREE.PlaneGeometry(width, depth, divX, divZ);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) position.setY(i, sampleHeight(position.getX(i), position.getZ(i)));
  geometry.computeVertexNormals();
  const material = new THREE.MeshLambertMaterial();
  return new THREE.Mesh(geometry, material);
}

function buildingsFromPack(header, buffer, sampleHeight, models, tileSize) {
  const tiles = Object.entries(header.tiles);
  const vertices = tiles.reduce((sum, [, tile]) => sum + tile[1], 0);
  const faces = tiles.reduce((sum, [, tile]) => sum + tile[2], 0);
  const points = new Float32Array(vertices * 3);
  const colors = new Uint8Array(vertices * 4);
  const indices = new Uint32Array(faces);
  const masked = new Map();
  let vertex = 0;
  let index = 0;
  for (const [key, [offset, count, indexCount]] of tiles) {
    if (count % 8 !== 0 || offset + count * 16 + indexCount * 2 > buffer.byteLength) {
      throw new Error("远景建筑文件与索引不匹配");
    }
    const source = new Float32Array(buffer, offset, count * 3);
    const [tileX, tileZ] = key.split("_").map(Number);
    const nearby = replacementsInTile(models, tileX * tileSize, tileZ * tileSize, tileSize);
    const assignments = new Map();
    points.set(source, vertex * 3);
    for (let b = 0; b < count; b += 8) {
      let x = 0;
      let z = 0;
      for (let corner = 0; corner < 4; corner++) {
        const i = (b + corner) * 3;
        x += source[i];
        z += source[i + 2];
      }
      const y = sampleHeight(x / 4, z / 4);
      if (nearby.length) {
        const target = replacementAt(nearby, x / 4, z / 4);
        if (target) assignments.set(b / 8, target);
      }
      for (let corner = 0; corner < 8; corner++) points[(vertex + b + corner) * 3 + 1] += y;
    }
    colors.set(new Uint8Array(buffer, offset + count * 12, count * 4), vertex * 4);
    const local = new Uint16Array(buffer, offset + count * 16, indexCount);
    if (assignments.size) {
      for (let i = 0; i < local.length; i += 3) {
        const target = assignments.get(Math.floor(local[i] / 8));
        if (target) {
          if (!masked.has(target)) masked.set(target, []);
          masked.get(target).push(vertex + local[i], vertex + local[i + 1], vertex + local[i + 2]);
        } else {
          for (let k = 0; k < 3; k++) indices[index++] = vertex + local[i + k];
        }
      }
    } else {
      for (const value of local) indices[index++] = vertex + value;
    }
    vertex += count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4, true));
  geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, index), 1));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));
  for (const [target, originalIndices] of masked) {
    const original = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) original.setAttribute(name, attribute);
    original.setIndex(originalIndices);
    const mesh = new THREE.Mesh(original, material);
    mesh.name = target;
    group.add(mesh);
  }
  return group;
}

function markerTexture() {
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext("2d");
  ctx.beginPath();
  ctx.arc(16, 16, 12, 0, Math.PI * 2);
  ctx.fillStyle = "#e8e3b0";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#335246";
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class TerrainView {
  static async open(host, world, landmarks, index, replacements, onSelect, onReadout) {
    const { revision } = index;
    const [height, header, pack] = await Promise.all([
      loadElevation(),
      fetchLocal("./data/hlod.json"),
      fetchLocal("./data/hlod.bin", "arrayBuffer")
    ]);
    if (header.revision !== revision) throw new Error("建筑数据版本与地图索引不匹配");
    const buildings = buildingsFromPack(header, pack, height, replacements, index.tileSize);
    return new TerrainView(host, world, landmarks, height, buildings, replacements, onSelect, onReadout);
  }

  constructor(host, world, landmarks, height, buildings, replacements, onSelect, onReadout) {
    this.host = host;
    this.world = world;
    this.height = height;
    this.onReadout = onReadout;
    this.onSelect = onSelect;
    this.landmarks = landmarks;
    this.buildings = buildings;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#a8c2be");
    this.scene.fog = new THREE.Fog("#a8c2be", 16500, 55000);
    const sky = new THREE.HemisphereLight("#f3faff", "#756650", 2.1);
    const sun = new THREE.DirectionalLight("#fff3d7", 2.3);
    sun.position.set(-3500, 6500, -4000);
    this.scene.add(sky, sun, buildings);
    this.camera = new THREE.PerspectiveCamera(42, 1, 4, 90000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(1.65, devicePixelRatio));
    this.renderer.setClearColor("#a8c2be");
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    host.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.maxPolarAngle = Math.PI * 0.475;
    this.controls.minDistance = 75;
    this.controls.maxDistance = 52500;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener("change", () => this.render());
    this.createGround();

    const positions = landmarks.flatMap(({ point: [x, z] }) => [x, height(x, z) + 17, z]);
    const points = new THREE.BufferGeometry();
    points.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const sprite = markerTexture();
    this.markers = new THREE.Points(points, new THREE.PointsMaterial({
      map: sprite, size: 7, sizeAttenuation: false, depthWrite: false, depthTest: false, transparent: true
    }));
    this.markers.renderOrder = 5;
    this.scene.add(this.markers);
    this.pin = new THREE.Sprite(new THREE.SpriteMaterial({
      map: sprite, color: "#f6cc73", depthTest: false, depthWrite: false, sizeAttenuation: false
    }));
    this.pin.scale.set(0.026, 0.026, 1);
    this.pin.renderOrder = 6;
    this.pin.visible = false;
    this.scene.add(this.pin);
    this.label = document.createElement("output");
    this.label.className = "terrain-label";
    host.append(this.label);
    new ResizeObserver(() => this.resize()).observe(host);
    this.bindSelection();
    this.landmarkLayer = new LandmarkLayer(this.scene, landmarks, height, () => this.render(),
      replacements, (id, active) => {
        const original = buildings.getObjectByName(id);
        if (original) original.visible = !active;
      });
  }

  createGround() {
    const extent = this.world.extent;
    const size = 6400;
    this.patches = [];
    for (let x = extent.minX; x < extent.maxX; x += size) {
      for (let z = extent.minZ; z < extent.maxZ; z += size) {
        const bounds = { minX: x, maxX: Math.min(x + size, extent.maxX),
          minZ: z, maxZ: Math.min(z + size, extent.maxZ) };
        const ground = makeGround(bounds, this.height);
        this.patches.push({ bounds, ground });
        this.scene.add(ground);
      }
    }
  }

  updateTextures(showRoads) {
    for (const { bounds, ground } of this.patches) {
      const canvas = new OffscreenCanvas(1024, 1024);
      paintBase(canvas.getContext("2d"), this.world, bounds, 1024, 1024, showRoads, true);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      ground.material.map?.dispose();
      ground.material.map = texture;
      ground.material.needsUpdate = true;
    }
  }

  bindSelection() {
    const canvas = this.renderer.domElement;
    let start;
    canvas.addEventListener("pointerdown", event => {
      start = event.button === 0 ? [event.clientX, event.clientY] : null;
    });
    canvas.addEventListener("pointerup", event => {
      if (!start || !this.markers.visible || Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 5) return;
      const rect = canvas.getBoundingClientRect();
      const attr = this.markers.geometry.getAttribute("position");
      const projected = new THREE.Vector3();
      let distance = 10;
      let chosen;
      for (let i = 0; i < attr.count; i++) {
        projected.fromBufferAttribute(attr, i).project(this.camera);
        if (Math.abs(projected.z) > 1) continue;
        const dx = rect.left + (projected.x + 1) * rect.width / 2 - event.clientX;
        const dy = rect.top + (1 - projected.y) * rect.height / 2 - event.clientY;
        const d = Math.hypot(dx, dy);
        if (d < distance) {
          distance = d;
          chosen = this.landmarks[i];
        }
      }
      if (chosen) this.onSelect(chosen);
    });
  }

  setOptions({ roads, places, buildings }) {
    if (roads !== this.showRoads) this.updateTextures(roads);
    this.showRoads = roads;
    this.markers.visible = places;
    this.buildings.visible = buildings;
    this.render();
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.host;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  select(place, entrance, highlight = true) {
    this.selected = place;
    this.pin.visible = !!place && highlight;
    this.label.textContent = place ? place.name + (entrance ? " · 入口" : "") : "";
    if (place) {
      const [x, z] = entrance || place.point;
      this.pin.position.set(x, this.height(x, z) + 22, z);
    }
    this.render();
  }

  focus([x, z], distance, targetHeight = 0, approach) {
    const y = this.height(x, z) + targetHeight;
    const d = THREE.MathUtils.clamp(distance, 75, 52500);
    this.controls.target.set(x, y, z);
    const heading = approach ? new THREE.Vector2(approach[0] - x, approach[1] - z).normalize() : new THREE.Vector2(0, 1);
    this.camera.position.set(x + heading.x * d * 0.724, y + d * 0.69, z + heading.y * d * 0.724);
    this.controls.update();
    this.resize();
  }

  zoom(factor) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance));
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
    this.render();
  }

  render() {
    if (this.host.hidden) return;
    const { x, z } = this.controls.target;
    this.landmarkLayer.update(x, z, this.camera.position.distanceTo(this.controls.target), this.selected?.id);
    this.renderer.render(this.scene, this.camera);
    this.label.hidden = !this.pin.visible;
    if (this.pin.visible) {
      const pos = this.pin.position.clone().project(this.camera);
      this.label.hidden = Math.abs(pos.x) > 0.98 || Math.abs(pos.y) > 0.98 || Math.abs(pos.z) > 1;
      this.label.style.left = `${(pos.x + 1) * 50}%`;
      this.label.style.top = `${(1 - pos.y) * 50}%`;
    }
    this.onReadout([x, z], null);
  }
}
