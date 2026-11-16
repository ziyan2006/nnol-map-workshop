import * as THREE from "three";
import { GLTFLoader } from "./vendor/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "./vendor/examples/jsm/libs/meshopt_decoder.module.js";
import { readReplacement } from "./replacements.js";

const directory = new URL("./data/landmarks/", import.meta.url);
let catalogRequest;

export function landmarkCatalog() {
  catalogRequest ??= fetch(new URL("index.json", directory)).then(response => {
    if (!response.ok) throw new Error(`地标清单 HTTP ${response.status}`);
    return response.json();
  }).catch(error => {
    catalogRequest = undefined;
    throw error;
  });
  return catalogRequest;
}

function disposeModel(model) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  model.traverse(node => {
    if (!node.isMesh) return;
    geometries.add(node.geometry);
    (Array.isArray(node.material) ? node.material : [node.material]).forEach(material => materials.add(material));
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    texture.image?.close?.();
  }
  for (const geometry of geometries) geometry.dispose();
  model.removeFromParent();
}

function placement(place, terrainHeight) {
  const [x, z] = place.point;
  const level = place.elevation == null || (place.elevation === 0 && place.model !== "liangqingBridge")
    ? terrainHeight(x, z) : place.elevation;
  const rotation = -(place.rotation || 0) * Math.PI / 180;
  return { x, z, level, rotation };
}

export class LandmarkLayer {
  constructor(scene, places, terrainHeight, onChange, replacements, onReplacement) {
    this.scene = scene;
    this.terrainHeight = terrainHeight;
    this.onChange = onChange;
    this.onReplacement = onReplacement;
    this.loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    this.expected = new Map();
    this.loaded = new Map();
    this.pending = new Map();
    this.failures = new Map();
    this.places = new Map(places.map(place => [place.id, place]));
    this.setup = landmarkCatalog().catch(error => {
      console.warn("无法读取精细地标清单", error);
      return { models: [] };
    }).then(catalog => {
      this.models = catalog.models.filter(model => model.glb && this.places.has(model.id)).map(model => ({
        ...model, place: this.places.get(model.id)
      }));
      this.models.push(...replacements.map(replacement => ({ ...replacement, replacement })));
      if (this.view) this.update(...this.view, true);
      return this.models;
    }).catch(error => {
      console.warn("无法加载精细地标清单", error);
      return [];
    });
  }

  update(x, z, range, selected, force = false) {
    const last = this.evaluated;
    this.view = [x, z, range, selected];
    if (!this.models || (!force && last && selected === last[3] &&
      Math.abs(range - last[2]) < 180 && Math.hypot(x - last[0], z - last[1]) < 85)) return;
    this.evaluated = this.view;
    const ordered = this.models.map(model => {
      const [px, pz] = model.place.point;
      return { model, distance: Math.hypot(px - x, pz - z), selected: model.id === selected };
    }).sort((a, b) => Number(b.selected) - Number(a.selected) || a.distance - b.distance);
    const nearby = range > 7800 ? [] : ordered.filter(item => item.distance < 2600).slice(0, 5);
    this.expected = new Map(nearby.map(({ model, distance, selected }, index) => [
      model.id, { model, quality: (selected || (index < 2 && distance < 1250 && range < 3700)) ? "glb" : "preview" }
    ]));
    for (const [id, entry] of this.loaded) {
      if (this.expected.has(id)) continue;
      disposeModel(entry.root);
      this.loaded.delete(id);
      if (entry.replacement) this.onReplacement(id, false);
    }
    this.next();
  }

  next() {
    if (this.pending.size >= 2) return;
    for (const [id, expectation] of this.expected) {
      if (this.pending.size >= 2) break;
      const { model, quality } = expectation;
      const level = model[quality] ? quality : "glb";
      const existing = this.loaded.get(id);
      if (existing?.quality === "glb" || existing?.quality === level || this.pending.has(id)) continue;
      if ((this.failures.get(id) ?? 0) > Date.now()) continue;
      this.pending.set(id, true);
      const replacement = model.replacement;
      const load = replacement
        ? readReplacement(replacement).then(bytes => this.loader.parseAsync(bytes, ""))
        : this.loader.loadAsync(new URL(model[level], directory).href);
      load.then(asset => {
        if (!this.expected.has(id)) {
          disposeModel(asset.scene);
          return;
        }
        const root = asset.scene;
        if (replacement) {
          const [x, z, offset] = replacement.placement.anchor;
          const bounds = new THREE.Box3().setFromObject(root);
          const dimensions = bounds.getSize(new THREE.Vector3()).toArray();
          if (bounds.isEmpty() || !dimensions.every(value => Number.isFinite(value) &&
              value * replacement.placement.scale > 0 && value * replacement.placement.scale <= 500)) {
            disposeModel(root);
            throw new Error("替换模型的尺寸无效");
          }
          root.position.set(x, this.terrainHeight(x, z) + offset, z);
          root.rotation.y = THREE.MathUtils.degToRad(replacement.placement.yaw);
          root.scale.setScalar(replacement.placement.scale);
        } else {
          const { x, z, level: y, rotation } = placement(model.place, this.terrainHeight);
          root.position.set(x, y, z);
          root.rotation.y = rotation;
        }
        if (existing) disposeModel(existing.root);
        root.name = model.place.name;
        this.scene.add(root);
        this.loaded.set(id, { root, quality: level, replacement });
        if (replacement) this.onReplacement(id, true);
      }).catch(error => {
        this.failures.set(id, Date.now() + 8000);
        console.warn(`精细地标未加载 · ${model.place.name}`, error);
      }).finally(() => {
        this.pending.delete(id);
        this.onChange();
        this.next();
      });
    }
  }
}
