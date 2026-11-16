const source = new URL("./city-source/", document.baseURI);
const prebaked = new Set(["0_0", "1_0", "0_1", "1_1"]);
export const tileKey = (x, z, size) => `${Math.floor(x / size)}_${Math.floor(z / size)}`;

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname} · HTTP ${response.status}`);
  return response.json();
}

export class StreetTileSource {
  constructor(index, readPack) {
    this.index = index;
    this.readPack = readPack;
    this.positions = new Set(index.tiles.map(([x, z]) => `${x}_${z}`));
    this.id = 0;
    this.pending = new Map();
  }

  neighbors([x, z], limit) {
    const size = this.index.tileSize;
    const ix = Math.floor(x / size);
    const iz = Math.floor(z / size);
    const result = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const sx = ix + dx;
        const sz = iz + dz;
        const key = `${sx}_${sz}`;
        if (!this.positions.has(key)) continue;
        const px = Math.max(sx * size, Math.min(x, (sx + 1) * size));
        const pz = Math.max(sz * size, Math.min(z, (sz + 1) * size));
        result.push({ key, distance: Math.hypot(x - px, z - pz) });
      }
    }
    return result.sort((a, b) => a.distance - b.distance).slice(0, limit).map(item => item.key);
  }

  async start() {
    const [textureIndex, styles, catalog] = await Promise.all([
      readJson(new URL("./data/street/textures/index.json", document.baseURI)),
      readJson(new URL("styles/index.json", source)),
      readJson(new URL("./data/landmarks/index.json", document.baseURI))
    ]);
    if (styles.tileRevision !== this.index.revision || catalog.revision !== this.index.revision) {
      throw new Error("全城分块版本与本地地图不匹配");
    }
    const custom = new Set(catalog.models.filter(model => model.glb).map(model => model.id));
    const keepOut = this.index.landmarks.filter(place => custom.has(place.id)).flatMap(place => {
      const [x, z] = place.point;
      const rings = place.clearRings ?? (place.clearRing ? [place.clearRing] : []);
      return rings.map(ring => ring.map(([dx, dz]) => [x + dx, z + dz]));
    });
    const worker = new Worker(new URL("./vendor/nanning/tile.worker.js", import.meta.url));
    worker.addEventListener("message", ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      if (data.phase === "fetched") {
        worker.postMessage({ type: "generate", id: data.id });
        return;
      }
      if (data.error) request.finish(new Error(data.error));
      else request.finish(null, data.build);
    });
    worker.addEventListener("error", event => {
      worker.terminate();
      this.ready = null;
      for (const request of this.pending.values()) request.finish(new Error(event.message || "分块生成失败"));
    });
    worker.postMessage({
      type: "init", baseUrl: source.href, revision: this.index.revision, tileSize: this.index.tileSize,
      facades: textureIndex.facades, buildingStyles: `${styles.version}-${this.index.revision}`,
      qingxiuStyles: true, keepOut, activeRoadOwners: [], lifeLayer: true
    });
    return worker;
  }

  async load(key) {
    if (prebaked.has(key)) return this.readPack(key);
    if (!this.positions.has(key)) throw new Error("坐标超出街景范围");
    this.ready ??= this.start().catch(error => {
      this.ready = null;
      throw error;
    });
    const worker = await this.ready;
    const [ix, iz] = key.split("_").map(Number);
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.postMessage({ type: "cancel", id });
        finish(new Error(`街景分块 ${key} 加载超时`));
      }, 55000);
      const finish = (error, build) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(build);
      };
      this.pending.set(id, { finish });
      worker.postMessage({ type: "build", id, ix, iz, lod: "near" });
    });
  }
}
