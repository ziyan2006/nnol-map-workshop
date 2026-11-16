import * as THREE from "three";
import { buildingMaterial, groundMaterial, makeSky, readTextureArray, textureArray } from "./street-materials.js";
import { LandmarkLayer } from "./landmarks.js";
import { loadElevation } from "./terrain.js";
import { StreetTileSource, tileKey } from "./street-tiles.js";
import { replacementAt, replacementsInTile } from "./replacements.js";

const streetLocation = [708.028, 695.747];
const eyeHeight = 1.68;
const maxFlightHeight = 500;
const lightColors = {
  sky: [new THREE.Color("#d9eaff"), new THREE.Color("#87a7ff")],
  ground: [new THREE.Color("#b1a58c"), new THREE.Color("#233663")],
  key: [new THREE.Color("#fff3d6"), new THREE.Color("#7299f8")],
  fog: [new THREE.Color("#a0bbc4"), new THREE.Color("#1c2e58")]
};
const warmLight = new THREE.Color("#ffb47d");
const nightDirection = new THREE.Vector3(100, 190, 40).normalize();
const data = new URL("./data/street/", import.meta.url);
const textureDirectory = new URL("./textures/", data);
const arrayType = { Float32Array, Int16Array, Uint16Array, Uint8Array, Uint32Array };

async function checked(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`街景资源加载失败：${url.pathname}`);
  return response;
}

async function unzip(path) {
  const response = await checked(new URL(path, data));
  return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

async function readPack(name) {
  const [map, buffer] = await Promise.all([
    checked(new URL(`${name}.json`, data)).then(res => res.json()),
    unzip(`${name}.bin.gz`)
  ]);
  return Object.fromEntries(Object.entries(map).map(([key, part]) => [
    key, Object.fromEntries(Object.entries(part).map(([attribute, [offset, length, type]]) => [
      attribute, new arrayType[type](buffer, offset, length)
    ]))
  ]));
}

function geometryOf(part) {
  const geometry = new THREE.BufferGeometry();
  const assign = (name, values, size, normalized = false) => {
    if (values) geometry.setAttribute(name, new THREE.BufferAttribute(values, size, normalized));
  };
  assign("position", part.position, 3);
  if (part.normal16) assign("normal", part.normal16, 4, true);
  else assign("normal", part.normal, 3);
  if (part.color16) assign("color", part.color16, 4, true);
  else assign("color", part.color, 3);
  assign("uv", part.uv, 2);
  assign("layer", part.layer, 1);
  assign("paint", part.paint, 3);
  if (part.index) geometry.setIndex(new THREE.BufferAttribute(part.index, 1));
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function addBuildings(group, geometry, material, models, layer) {
  if (models.length === 0 || !geometry.index) {
    group.add(new THREE.Mesh(geometry, material));
    return;
  }
  const { array: indices } = geometry.index;
  const positions = geometry.getAttribute("position");
  const original = new Map();
  const remaining = new indices.constructor(indices.length);
  let count = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const x = (positions.getX(a) + positions.getX(b) + positions.getX(c)) / 3;
    const z = (positions.getZ(a) + positions.getZ(b) + positions.getZ(c)) / 3;
    const target = replacementAt(models, x, z);
    if (target) {
      if (!original.has(target)) original.set(target, []);
      original.get(target).push(a, b, c);
    } else {
      remaining[count++] = a;
      remaining[count++] = b;
      remaining[count++] = c;
    }
  }
  if (original.size) geometry.setIndex(new THREE.BufferAttribute(remaining.subarray(0, count), 1));
  group.add(new THREE.Mesh(geometry, material));
  for (const [target, subset] of original) {
    const cut = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) cut.setAttribute(name, attribute);
    cut.setIndex(subset);
    const mesh = new THREE.Mesh(cut, material);
    mesh.name = target;
    mesh.visible = !layer.loaded.has(target);
    group.add(mesh);
  }
}

function groundHeightLookup({ position, index }) {
  const size = 24;
  const cells = new Map();
  const key = (x, z) => `${x}/${z}`;
  for (let i = 0; i < index.length; i += 3) {
    const vertices = [index[i], index[i + 1], index[i + 2]].map(v => v * 3);
    const xs = vertices.map(v => Math.floor(position[v] / size));
    const zs = vertices.map(v => Math.floor(position[v + 2] / size));
    for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z++) {
        const id = key(x, z);
        if (!cells.has(id)) cells.set(id, []);
        cells.get(id).push(i);
      }
    }
  }
  return (x, z) => {
    let height = -Infinity;
    const nearby = cells.get(key(Math.floor(x / size), Math.floor(z / size))) ?? [];
    for (const i of nearby) {
      const a = index[i] * 3;
      const b = index[i + 1] * 3;
      const c = index[i + 2] * 3;
      const bx = position[b] - position[a];
      const bz = position[b + 2] - position[a + 2];
      const cx = position[c] - position[a];
      const cz = position[c + 2] - position[a + 2];
      const determinant = bx * cz - cx * bz;
      if (Math.abs(determinant) < 1e-7) continue;
      const dx = x - position[a];
      const dz = z - position[a + 2];
      const u = (dx * cz - cx * dz) / determinant;
      const v = (bx * dz - dx * bz) / determinant;
      if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) {
        height = Math.max(height, position[a + 1] * (1 - u - v) + position[b + 1] * u + position[c + 1] * v);
      }
    }
    return Number.isFinite(height) ? height : undefined;
  };
}

async function getTextures() {
  const metadata = await checked(new URL("./index.json", textureDirectory)).then(res => res.json());
  const loader = new THREE.TextureLoader();
  const leaves = species => loader.loadAsync(new URL(`leaves-${species}.webp`, textureDirectory).href).then(texture => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  });
  const [regular, ground, facadeData, facadeInfo, broad, palm, storefronts] = await Promise.all([
    readTextureArray(textureDirectory, metadata.facades, 768),
    readTextureArray(textureDirectory, metadata.grounds, 512),
    unzip("facades.bin.gz"),
    checked(new URL("facades.json", data)).then(res => res.json()),
    leaves("broad"),
    leaves("palm"),
    loader.loadAsync(new URL("storefronts.png", textureDirectory).href)
  ]);
  storefronts.flipY = false;
  storefronts.colorSpace = THREE.SRGBColorSpace;
  storefronts.anisotropy = 4;
  storefronts.needsUpdate = true;
  const parametric = textureArray(new Uint8Array(facadeData), facadeInfo.size, facadeInfo.count);
  return { regular, ground, parametric, storefronts, metadata, broad, palm };
}

function streetMaterials(textures, night) {
  const neutral = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, side: THREE.DoubleSide });
  const wall = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
  const leaf = map => new THREE.MeshStandardMaterial({
    map, vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.45, roughness: 0.91
  });
  const roadPaint = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.65, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  const iron = new Uint8Array(32 * 128 * 4);
  for (let y = 0; y < 128; y++) {
    const rail = y / 128;
    for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 4;
      iron[i] = iron[i + 1] = iron[i + 2] = 255;
      iron[i + 3] = x < 4 || (rail >= 0.34 && rail <= 0.41) || (rail >= 0.77 && rail <= 0.84) ? 255 : 0;
    }
  }
  const ironMap = new THREE.DataTexture(iron, 32, 128);
  ironMap.wrapS = THREE.RepeatWrapping;
  ironMap.minFilter = THREE.LinearMipmapLinearFilter;
  ironMap.magFilter = THREE.LinearFilter;
  ironMap.generateMipmaps = true;
  ironMap.needsUpdate = true;
  return {
    buildings: buildingMaterial(textures.regular, textures.parametric, textures.storefronts, textures.metadata, night),
    ground: groundMaterial(textures.ground, textures.metadata.grounds),
    marks: roadPaint,
    parkedCarInk: new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1 }),
    water: new THREE.MeshStandardMaterial({ color: "#315d78", roughness: 0.47, metalness: 0.1 }),
    walls: wall,
    fences: new THREE.MeshStandardMaterial({ map: ironMap, vertexColors: true, alphaTest: 0.5,
      side: THREE.DoubleSide, roughness: 0.86, metalness: 0.15 }),
    broadLeaves: leaf(textures.broad),
    palmLeaves: leaf(textures.palm),
    treeTrunk: wall,
    neutral
  };
}

const drawParts = [
  "buildings", "ground", "water", "marks", "signals", "signs", "roadSigns", "barriers", "streetLamps", "walls",
  "fences", "compoundEntrances", "gateLights", "assets", "parkedCars", "parkedCarInk",
  "districtBrick", "districtStone", "districtRoof", "districtWood", "districtPlaster", "districtGlass", "districtMetal"
];

export class StreetView {
  static async open(host, readout, index, replacements, onTileStatus, onPose) {
    const [textures, trees, elevation] = await Promise.all([
      getTextures(), readPack("trees"), loadElevation()
    ]);
    return new StreetView(host, readout, textures, trees, elevation, index, replacements, onTileStatus, onPose);
  }

  constructor(host, readout, textures, trees, elevation, index, replacements, onTileStatus, onPose) {
    this.host = host;
    this.readout = readout;
    this.onTileStatus = onTileStatus;
    this.onPose = onPose;
    this.flying = false;
    this.flightSpeed = 30;
    this.elevation = elevation;
    this.tileSize = index.tileSize;
    this.replacements = replacements;
    this.tiles = new StreetTileSource(index, readPack);
    this.resident = new Map();
    this.loading = new Map();
    this.tileErrors = new Map();
    this.night = { value: 1 };
    this.twilight = { value: 0 };
    this.sun = { value: new THREE.Vector3() };
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2("#0c1630", 0.0010);
    this.sky = makeSky(this.night, this.twilight, this.sun);
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    this.ambient = new THREE.HemisphereLight();
    this.keyLight = new THREE.DirectionalLight();
    this.scene.add(this.ambient, this.keyLight);
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.12, 2800);
    this.camera.rotation.order = "YXZ";
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(1.5, devicePixelRatio));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute("aria-label", "街景。拖动转头，W A S D 或方向键移动，F 切换飞行");
    this.materials = streetMaterials(textures, this.night);
    this.grounds = new Map();
    this.treeCells = [];
    this.treeGeometry = Object.fromEntries(Object.entries(trees).map(([part, raw]) => [part, geometryOf(raw)]));
    this.lampHalo = this.makeHalo();
    this.host.append(this.renderer.domElement);
    this.buttons = new Set();
    this.frame = 0;
    this.bind();
    this.landmarks = new LandmarkLayer(this.scene, index.landmarks, elevation, () => this.render(),
      replacements, (target, active) => {
        for (const tile of this.resident.values()) {
          const original = tile.getObjectByName(target);
          if (original) original.visible = !active;
        }
      });
    new ResizeObserver(() => this.resize()).observe(host);
  }

  attachTile(id, tile) {
    if (!tile?.ground?.position) throw new Error(`街景分块 ${id} 缺少可用地面`);
    const group = new THREE.Group();
    group.name = `街景 ${id}`;
    for (const key of drawParts) {
      const part = tile[key];
      if (!part?.position) continue;
      const geometry = geometryOf(part);
      if (key === "buildings" && !part.paint) {
        geometry.setAttribute("paint", new THREE.BufferAttribute(new Float32Array(part.position.length), 3));
      }
      const material = this.materials[key] ?? this.materials.neutral;
      if (key === "buildings") {
        const [x, z] = id.split("_").map(value => Number(value) * this.tileSize);
        const replacements = replacementsInTile(this.replacements, x, z, this.tileSize);
        addBuildings(group, geometry, material, replacements, this.landmarks);
      } else {
        group.add(new THREE.Mesh(geometry, material));
      }
    }
    const land = groundHeightLookup(tile.ground);
    const water = tile.water?.index ? groundHeightLookup(tile.water) : null;
    this.grounds.set(id, water ? (x, z) => {
      const landHeight = land(x, z);
      const waterHeight = water(x, z);
      return landHeight === undefined ? waterHeight : Math.max(landHeight, waterHeight ?? landHeight);
    } : land);
    if (tile.trees) this.addTrees(group, tile.trees);
    if (tile.streetLampSources) this.addLamps(group, tile.streetLampSources.data ?? tile.streetLampSources);
    this.scene.add(group);
    this.resident.set(id, group);
  }

  loadTile(id) {
    if (this.resident.has(id)) return Promise.resolve();
    if (this.loading.has(id)) return this.loading.get(id);
    const load = this.tiles.load(id).then(data => {
      this.attachTile(id, data);
      this.tileErrors.delete(id);
    }).catch(error => {
      this.tileErrors.set(id, Date.now() + 10000);
      throw error;
    }).finally(() => this.loading.delete(id));
    this.loading.set(id, load);
    return load;
  }

  async flyTo(point = streetLocation, target, selected, lookHeight) {
    const ticket = this.flyTicket = (this.flyTicket ?? 0) + 1;
    const id = tileKey(...point, this.tileSize);
    await this.loadTile(id);
    if (ticket !== this.flyTicket) return;
    this.started = true;
    this.flying = false;
    this.buttons.clear();
    this.selected = selected;
    this.camera.fov = 58;
    this.camera.updateProjectionMatrix();
    const yaw = target ? Math.atan2(point[0] - target[0], point[1] - target[1]) : point === streetLocation ? -3.72 : 0;
    this.camera.rotation.set(0.025, yaw, 0, "YXZ");
    this.place(point[0], point[1], { arriving: true });
    if (target && lookHeight !== undefined) {
      const distance = Math.hypot(point[0] - target[0], point[1] - target[1]);
      const rise = this.elevation(...target) + lookHeight - this.camera.position.y;
      this.camera.rotation.x = Math.atan2(rise, distance);
    }
    this.syncTiles(point, true);
  }

  syncTiles(point, force = false) {
    const band = tileKey(...point, 200);
    if (!force && band === this.band) return;
    this.band = band;
    this.wanted = new Set(this.tiles.neighbors(point, this.flying ? 6 : 4));
    this.pruneTiles();
    this.loadNeighbors();
  }

  loadNeighbors() {
    if (this.host.hidden) return;
    for (const id of this.wanted ?? []) {
      if (this.loading.size >= 2) break;
      if (this.resident.has(id) || this.loading.has(id) || (this.tileErrors.get(id) ?? 0) > Date.now()) continue;
      this.loadTile(id).catch(() => {}).finally(() => {
        this.pruneTiles();
        this.updateTreeVisibility();
        this.render();
        this.loadNeighbors();
      });
    }
  }

  pruneTiles() {
    const current = tileKey(this.camera.position.x, this.camera.position.z, this.tileSize);
    for (const [id, group] of this.resident) {
      if (this.wanted?.has(id) || id === current) continue;
      group.traverse(object => {
        if (object.isInstancedMesh) object.dispose();
        else object.geometry?.dispose();
      });
      this.treeCells = this.treeCells.filter(cell => cell.cluster.parent !== group);
      group.removeFromParent();
      this.resident.delete(id);
      this.grounds.delete(id);
    }
  }

  addTrees(group, arrays) {
    for (const type of ["broad", "palm"]) {
      const matrices = arrays[type];
      if (!matrices?.length) continue;
      const colors = arrays[`${type}Color`];
      const clusters = new Map();
      for (let i = 0; i < matrices.length / 16; i++) {
        const x = Math.floor(matrices[i * 16 + 12] / 140);
        const z = Math.floor(matrices[i * 16 + 14] / 140);
        const name = `${x}/${z}`;
        if (!clusters.has(name)) clusters.set(name, { x: (x + 0.5) * 140, z: (z + 0.5) * 140, trees: [] });
        clusters.get(name).trees.push(i);
      }
      for (const { x, z, trees } of clusters.values()) {
        const cluster = new THREE.Group();
        for (const part of ["Trunk", "Leaves"]) {
          const mesh = new THREE.InstancedMesh(this.treeGeometry[type + part],
            part === "Trunk" ? this.materials.treeTrunk : this.materials[`${type}Leaves`], trees.length);
          const tint = part === "Leaves" && colors ? new Float32Array(trees.length * 3) : null;
          for (const [i, source] of trees.entries()) {
            mesh.instanceMatrix.array.set(matrices.subarray(source * 16, source * 16 + 16), i * 16);
            tint?.set(colors.subarray(source * 3, source * 3 + 3), i * 3);
          }
          if (tint) mesh.instanceColor = new THREE.InstancedBufferAttribute(tint, 3);
          mesh.computeBoundingSphere();
          cluster.add(mesh);
        }
        this.treeCells.push({ x, z, cluster });
        group.add(cluster);
      }
    }
  }

  makeHalo() {
    const canvas = new OffscreenCanvas(32, 32);
    const context = canvas.getContext("2d");
    const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, "#fff7d0");
    gradient.addColorStop(0.2, "#e9d390bc");
    gradient.addColorStop(0.55, "#e9c26436");
    gradient.addColorStop(1, "#e9c26400");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    return new THREE.PointsMaterial({
      map, color: "#ffe3ab", size: 2.8, transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending
    });
  }

  addLamps(group, array) {
    const points = [];
    for (let i = 0; i + 5 < array.length; i += 6) points.push(array[i], array[i + 1], array[i + 2]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    group.add(new THREE.Points(geometry, this.lampHalo));
  }

  setTime(minutes) {
    const angle = (minutes / 60 - 6) / 24 * Math.PI * 2;
    const altitude = Math.sin(angle);
    const night = 1 - THREE.MathUtils.smoothstep(altitude, -0.15, 0.15);
    const twilight = 1 - THREE.MathUtils.smoothstep(Math.abs(altitude), 0.02, 0.36);
    this.night.value = night;
    this.twilight.value = twilight;
    this.sun.value.set(Math.cos(angle), Math.max(0.04, altitude), 0.38).normalize();
    this.keyLight.position.copy(this.sun.value).lerp(nightDirection, night).normalize();
    this.ambient.color.copy(lightColors.sky[0]).lerp(lightColors.sky[1], night);
    this.ambient.groundColor.copy(lightColors.ground[0]).lerp(lightColors.ground[1], night);
    this.ambient.intensity = THREE.MathUtils.lerp(1.7, 0.28, night);
    this.keyLight.color.copy(lightColors.key[0]).lerp(lightColors.key[1], night).lerp(warmLight, twilight * 0.65);
    this.keyLight.intensity = THREE.MathUtils.lerp(2, 0.34, night);
    this.scene.fog.color.copy(lightColors.fog[0]).lerp(lightColors.fog[1], night);
    this.lampHalo.visible = night > 0;
    this.lampHalo.opacity = night * 0.9;
    if (!this.timeFrame) {
      this.timeFrame = requestAnimationFrame(() => {
        this.timeFrame = 0;
        this.render();
      });
    }
    return minutes < 6 * 60 || minutes >= 18 * 60;
  }

  show() {
    this.resize();
    this.loadNeighbors();
    this.renderer.domElement.focus({ preventScroll: true });
  }

  hide() {
    this.buttons.clear();
    this.drag = null;
  }

  zoom(factor) {
    this.camera.fov = THREE.MathUtils.clamp(this.camera.fov * factor, 27, 78);
    this.camera.updateProjectionMatrix();
    this.render();
  }

  toggleFlight() {
    if (!this.started) return;
    this.flying = !this.flying;
    this.buttons.clear();
    const { x, z } = this.camera.position;
    const altitude = this.flying ? this.groundY + 10 : undefined;
    this.place(x, z, { arriving: true, altitude });
    this.syncTiles([x, z], true);
  }

  place(x, z, { arriving = false, altitude } = {}) {
    const id = tileKey(x, z, this.tileSize);
    const ground = this.grounds.get(id);
    if (!ground) {
      if (!this.tiles.positions.has(id) || this.loading.has(id) || (this.tileErrors.get(id) ?? 0) > Date.now()) return false;
      this.onTileStatus("正在载入相邻街区…");
      this.loadTile(id).then(() => {
        this.onTileStatus();
        if (this.host.hidden) return;
        this.wanted.add(id);
        this.updateTreeVisibility();
        this.render();
      }).catch(() => this.onTileStatus("相邻街区暂未载入，可稍后重试。"));
      return false;
    }
    this.groundY = ground(x, z) ?? (arriving || this.flying ? this.elevation(x, z) : this.camera.position.y - eyeHeight);
    const eye = this.groundY + eyeHeight;
    const y = this.flying
      ? THREE.MathUtils.clamp(altitude ?? this.camera.position.y, eye, this.groundY + maxFlightHeight)
      : eye;
    this.camera.position.set(x, y, z);
    this.updateTreeVisibility();
    this.syncTiles([x, z]);
    this.readout([x, z], null);
    this.render();
    return true;
  }

  updateTreeVisibility() {
    const { x, z } = this.camera.position;
    for (const cell of this.treeCells) {
      cell.cluster.visible = (x - cell.x) ** 2 + (z - cell.z) ** 2 < 550 ** 2;
    }
  }

  move(time) {
    this.frame = 0;
    if (this.host.hidden || !this.buttons.size) return;
    const seconds = Math.min(0.09, (time - this.time) / 1000);
    this.time = time;
    const dx = Number(this.buttons.has("right")) - Number(this.buttons.has("left"));
    const dz = Number(this.buttons.has("back")) - Number(this.buttons.has("forward"));
    const shift = this.buttons.has("shift");
    const dy = this.flying ? Number(this.buttons.has("rise")) - Number(shift) : 0;
    if (dx || dy || dz) {
      const { x, y, z } = this.camera.position;
      const yaw = this.camera.rotation.y;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const speed = this.flying ? this.flightSpeed : shift ? 11 : 5.2;
      const step = speed * seconds / Math.hypot(dx, dy, dz);
      const nextX = x + step * (dx * cos + dz * sin);
      const nextZ = z + step * (dz * cos - dx * sin);
      const altitude = y + step * dy;
      if (!this.place(nextX, nextZ, { altitude }) && dy) {
        this.place(x, z, { altitude });
      }
    }
    this.frame = requestAnimationFrame(now => this.move(now));
  }

  bind() {
    const canvas = this.renderer.domElement;
    const controls = {
      KeyW: "forward", ArrowUp: "forward", KeyS: "back", ArrowDown: "back",
      KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
      ShiftLeft: "shift", ShiftRight: "shift", Space: "rise"
    };
    canvas.addEventListener("keydown", event => {
      if (event.code === "KeyF" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!event.repeat) this.toggleFlight();
        return;
      }
      const key = controls[event.code];
      if (!key || (key === "rise" && !this.flying)) return;
      event.preventDefault();
      this.buttons.add(key);
      if (!this.frame) {
        this.time = performance.now();
        this.frame = requestAnimationFrame(now => this.move(now));
      }
    });
    canvas.addEventListener("keyup", event => this.buttons.delete(controls[event.code]));
    canvas.addEventListener("blur", () => this.hide());
    canvas.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      this.drag = [event.clientX, event.clientY];
    });
    canvas.addEventListener("pointermove", event => {
      if (!this.drag) return;
      const [x, y] = this.drag;
      this.drag = [event.clientX, event.clientY];
      this.camera.rotation.y -= (event.clientX - x) * 0.004;
      this.camera.rotation.x = THREE.MathUtils.clamp(this.camera.rotation.x - (event.clientY - y) * 0.004, -1.42, 1.42);
      this.render();
    });
    canvas.addEventListener("lostpointercapture", () => { this.drag = null; });
    canvas.addEventListener("wheel", event => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      if (this.flying) {
        const factor = Math.exp(THREE.MathUtils.clamp(-delta * 0.002, -0.45, 0.45));
        this.flightSpeed = THREE.MathUtils.clamp(this.flightSpeed * factor, 5, 200);
        this.reportPose();
      } else {
        this.zoom(Math.exp(THREE.MathUtils.clamp(delta * 0.001, -0.25, 0.25)));
      }
    }, { passive: false });
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.host;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.render();
  }

  render() {
    if (this.host.hidden || !this.started) return;
    this.landmarks.update(this.camera.position.x, this.camera.position.z, 900, this.selected);
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    this.reportPose();
  }

  reportPose() {
    if (this.host.hidden || !this.started) return;
    const { x, y, z } = this.camera.position;
    this.onPose({
      x, z, yaw: this.camera.rotation.y, flying: this.flying,
      speed: Math.round(this.flightSpeed), height: Math.max(0, Math.round(y - this.groundY))
    });
  }
}
