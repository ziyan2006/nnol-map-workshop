const landColors = { forest: "#304c3a", park: "#3a5640", water: "#3d757c" };
const terrainColors = { forest: "#4c7353", park: "#608959", water: "#47858d" };
const roadLevels = ["track", "pedestrian", "service", "residential", "tertiary", "secondary", "primary", "trunk", "motorway"];
const roadColors = ["#647261", "#a1a27e", "#6b776b", "#7e897b", "#a0a598", "#c2bb9b", "#d1bc96", "#d8b795", "#dab18e"];
const coarseSpacing = [2, 2, 1, 1, 0.8, 0.6, 0.5, 0.4, 0.3];

function pathOf(points, path = new Path2D(), close = false) {
  if (points.length < 2) return path;
  path.moveTo(...points[0]);
  for (let i = 1; i < points.length; i++) path.lineTo(...points[i]);
  if (close) path.closePath();
  return path;
}

function pointBounds(points) {
  const box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const [x, z] of points) {
    box.minX = Math.min(box.minX, x);
    box.minZ = Math.min(box.minZ, z);
    box.maxX = Math.max(box.maxX, x);
    box.maxZ = Math.max(box.maxZ, z);
  }
  return box;
}

function intersects(a, b, margin = 0) {
  return a.minX <= b.maxX + margin && a.maxX >= b.minX - margin &&
    a.minZ <= b.maxZ + margin && a.maxZ >= b.minZ - margin;
}

export function compileMap(data) {
  const areas = Object.keys(landColors).map(kind => ({
    kind,
    features: data.areas.filter(area => area.kind === kind).flatMap(area => area.polygons.map(polygon => {
      const path = new Path2D();
      for (const ring of polygon) pathOf(ring, path, true);
      return { path, bounds: pointBounds(polygon.flat()) };
    }))
  }));

  const replaced = new Set(data.viaductRoadIds);
  const roads = new Map();
  function addRoad(road, points) {
    if (points.length < 2) return;
    const level = Math.max(0, roadLevels.indexOf(road.kind));
    const grade = road.tunnel ? 0 : road.bridge ? 2 : 1;
    const width = Math.max(1, Math.round(road.width || 5));
    const key = [grade, level, width].join("/");
    if (!roads.has(key)) roads.set(key, { grade, level, width, features: [] });
    roads.get(key).features.push({ points, bounds: pointBounds(points) });
  }
  for (const road of data.mapRoads ?? data.roads) {
    if (!replaced.has(road.id) || road.tunnel) addRoad(road, road.points);
  }
  for (const road of data.viaducts ?? []) {
    addRoad({ kind: road.kind === "main" ? "trunk" : "secondary", width: road.width ?? 11, bridge: true },
      road.points.map(([x, z]) => [x, z]));
  }
  return { extent: data.extent, areas, roads: [...roads.values()].sort((a, b) => a.grade - b.grade || a.level - b.level) };
}

export function paintBase(ctx, world, bounds, width, height, showRoads, perspective = false) {
  const resolution = (bounds.maxX - bounds.minX) / width;
  const scaleX = width / (bounds.maxX - bounds.minX);
  const scaleZ = height / (bounds.maxZ - bounds.minZ);
  ctx.fillStyle = perspective ? "#718964" : "#283a32";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.transform(scaleX, 0, 0, scaleZ, -bounds.minX * scaleX, -bounds.minZ * scaleZ);
  for (const { kind, features } of world.areas) {
    ctx.fillStyle = (perspective ? terrainColors : landColors)[kind];
    for (const feature of features) {
      if (intersects(bounds, feature.bounds)) ctx.fill(feature.path, "evenodd");
    }
  }
  if (!perspective) {
    const e = world.extent;
    ctx.strokeStyle = "#a7bb9f5a";
    ctx.lineWidth = resolution;
    ctx.setLineDash([7 * resolution, 6 * resolution]);
    ctx.strokeRect(e.minX, e.minZ, e.maxX - e.minX, e.maxZ - e.minZ);
    ctx.setLineDash([]);
  }
  if (showRoads) {
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const { grade, level, width: roadWidth, features } of world.roads) {
      if ((!perspective && resolution > 17 && level < 4 && grade !== 2) ||
          (!perspective && resolution > 31 && level < 5 && grade !== 2)) continue;
      const path = new Path2D();
      let visible = false;
      for (const feature of features) {
        if (!intersects(bounds, feature.bounds, 30)) continue;
        pathOf(feature.points, path);
        visible = true;
      }
      if (!visible) continue;
      const heavy = level >= 5 || grade === 2;
      ctx.lineWidth = Math.max(roadWidth * (perspective ? 1 : 0.86), resolution * (heavy ? 1.12 : coarseSpacing[level] * 0.55));
      ctx.strokeStyle = grade === 0 ? "#9eaa9e" : perspective && !heavy ? "#b2b7a2" : roadColors[level];
      if (grade === 0) ctx.setLineDash([3 * resolution, 4 * resolution]);
      ctx.stroke(path);
      if (grade === 0) ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

export class MiniMap {
  constructor(button, world) {
    this.button = button;
    this.canvas = button.querySelector("canvas");
    this.range = button.querySelector(".minimap-range");
    this.world = world;
    this.context = this.canvas.getContext("2d", { alpha: false });
    this.base = document.createElement("canvas");
    this.baseContext = this.base.getContext("2d", { alpha: false });
  }

  draw({ x, z, yaw, flying }) {
    if (this.button.hidden) return;
    const span = flying ? 1800 : 800;
    const size = Math.round(this.canvas.clientWidth * Math.min(2, devicePixelRatio));
    if (!size) return;
    const previous = this.pose;
    if (previous?.size === size && previous.span === span && previous.x === x && previous.z === z && previous.yaw === yaw) return;
    this.pose = { x, z, yaw, span, size };
    const resolution = span / size;
    const margin = span * 0.25;
    const cached = this.cached;
    if (!cached || cached.size !== size || cached.span !== span ||
      Math.abs(x - cached.x) > margin || Math.abs(z - cached.z) > margin) {
      const baseSize = Math.ceil(size * 1.6);
      const radius = baseSize * resolution / 2;
      this.base.width = this.base.height = baseSize;
      paintBase(this.baseContext, this.world,
        { minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius },
        baseSize, baseSize, true);
      this.cached = { x, z, span, size };
      this.range.textContent = flying ? "1.8 km" : "800 m";
    }
    if (this.canvas.width !== size || this.canvas.height !== size) this.canvas.width = this.canvas.height = size;
    const half = size / 2;
    const baseHalf = this.base.width / 2;
    const ctx = this.context;
    ctx.drawImage(this.base, half - baseHalf + (this.cached.x - x) / resolution,
      half - baseHalf + (this.cached.z - z) / resolution);
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(-yaw);
    const unit = Math.min(2, devicePixelRatio);
    ctx.scale(unit, unit);
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#15251f";
    ctx.fillStyle = "#ffe0a8";
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
}

export class FlatMap {
  constructor(canvas, world, landmarks, onSelect, onPick, onReadout) {
    Object.assign(this, { canvas, world, landmarks, onSelect, onPick, onReadout });
    this.context = canvas.getContext("2d", { alpha: false });
    this.resolution = 30;
    this.showRoads = true;
    this.showPlaces = true;
    this.origin = [0, 0];
    this.markers = [];
    this.frame = 0;
    new ResizeObserver(() => this.requestDraw()).observe(canvas);
    this.bindControls();
  }

  bindControls() {
    const canvas = this.canvas;
    canvas.addEventListener("pointerdown", event => {
      if (event.button !== 0 || this.drag) return;
      const p = this.relative(event);
      this.drag = { id: event.pointerId, p, origin: [...this.origin], moved: false };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", event => {
      const [x, z] = this.relative(event);
      if (this.drag?.id === event.pointerId) {
        const dx = x - this.drag.p[0];
        const dz = z - this.drag.p[1];
        if (Math.hypot(dx, dz) > 4) this.drag.moved = true;
        if (this.drag.moved) {
          this.origin = [this.drag.origin[0] - dx * this.resolution, this.drag.origin[1] - dz * this.resolution];
          canvas.classList.add("dragging");
          this.requestDraw();
        }
      }
      this.onReadout(this.toWorld(x, z), this.resolution);
    });
    const endDrag = event => {
      if (this.drag?.id !== event.pointerId) return;
      const moved = this.drag.moved;
      this.drag = null;
      canvas.classList.remove("dragging");
      if (event.type !== "pointerup" || moved) return;
      const [x, z] = this.relative(event);
      const match = this.markers.findLast(marker => Math.hypot(marker.x - x, marker.z - z) <= marker.radius + 5);
      if (match) this.onSelect(match.place);
      else this.onPick(this.toWorld(x, z));
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("lostpointercapture", endDrag);
    canvas.addEventListener("contextmenu", event => {
      event.preventDefault();
      this.onPick(this.toWorld(...this.relative(event)));
    });
    canvas.addEventListener("wheel", event => {
      event.preventDefault();
      const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      this.zoom(Math.exp(Math.max(-0.7, Math.min(0.7, step * 0.0017))), this.relative(event));
    }, { passive: false });
    canvas.addEventListener("keydown", event => {
      const vectors = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = vectors[event.key];
      if (direction) {
        this.origin = this.origin.map((v, i) => v + direction[i] * this.resolution * 80);
        this.requestDraw();
      } else if (event.key === "+" || event.key === "=") {
        this.zoom(0.72);
      } else if (event.key === "-") {
        this.zoom(1.38);
      } else if (event.key === "Enter") {
        this.onPick([...this.origin]);
      } else return;
      event.preventDefault();
    });
  }

  relative(event) {
    const bounds = this.canvas.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  }

  toWorld(x, z) {
    return [this.origin[0] + (x - this.canvas.clientWidth / 2) * this.resolution,
      this.origin[1] + (z - this.canvas.clientHeight / 2) * this.resolution];
  }

  zoom(factor, anchor = [this.canvas.clientWidth / 2, this.canvas.clientHeight / 2]) {
    const point = this.toWorld(...anchor);
    this.resolution = Math.max(0.3, Math.min(170, this.resolution * factor));
    const after = this.toWorld(...anchor);
    this.origin = this.origin.map((v, i) => v + point[i] - after[i]);
    this.requestDraw();
  }

  focus(point, resolution) {
    this.origin = [...point];
    this.resolution = resolution;
    this.requestDraw();
  }

  fit() {
    const { minX, minZ, maxX, maxZ } = this.world.extent;
    this.focus([(minX + maxX) / 2, (minZ + maxZ) / 2],
      Math.max((maxX - minX) / Math.max(1, this.canvas.clientWidth - 62),
        (maxZ - minZ) / Math.max(1, this.canvas.clientHeight - 97)));
  }

  requestDraw() {
    if (!this.frame) this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(2, devicePixelRatio);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const [minX, minZ] = this.toWorld(0, 0);
    const [maxX, maxZ] = this.toWorld(width, height);
    const bounds = { minX, minZ, maxX, maxZ };
    paintBase(this.context, this.world, bounds, width, height, this.showRoads);
    this.drawMarkers(bounds, width, height);
    this.onReadout(this.origin, this.resolution);
  }

  drawMarkers(bounds, width, height) {
    const ctx = this.context;
    const markers = this.markers = [];
    const pixels = ([x, z]) => [(x - bounds.minX) / this.resolution, (z - bounds.minZ) / this.resolution];
    const cells = new Set();
    const density = this.resolution > 12 ? 42 : 23;
    const options = this.showPlaces ? this.landmarks : [];
    for (const place of options) {
      if (place === this.selected) continue;
      const [x, z] = pixels(place.point);
      if (x < 0 || z < 0 || x > width || z > height) continue;
      const key = [Math.floor(x / density), Math.floor(z / density)].join("/");
      if (cells.has(key)) continue;
      cells.add(key);
      markers.push({ x, z, radius: this.resolution < 10 ? 3.5 : 2.5, place });
    }
    if (this.selected) {
      const [x, z] = pixels(this.selected.point);
      markers.push({ x, z, radius: 6, place: this.selected });
    }
    for (const { x, z, radius, place } of markers) {
      const selected = place === this.selected;
      ctx.beginPath();
      ctx.arc(x, z, radius, 0, Math.PI * 2);
      ctx.fillStyle = selected ? "#f6d295" : "#c7d1ac";
      ctx.fill();
      if (!selected && this.resolution > 3) continue;
      ctx.lineWidth = selected ? 4 : 3;
      ctx.font = selected ? 'bold 14px "Microsoft YaHei UI", sans-serif' : '12px "Microsoft YaHei UI", sans-serif';
      ctx.textBaseline = "middle";
      ctx.strokeStyle = "#182620";
      ctx.strokeText(place.name, x + 10, z);
      ctx.fillStyle = selected ? "#fff2d6" : "#dce4d9";
      ctx.fillText(place.name, x + 10, z);
    }
    if (this.entrance) {
      const [x, z] = pixels(this.entrance);
      ctx.fillStyle = "#8edac2";
      ctx.fillRect(x - 4, z - 4, 8, 8);
      ctx.strokeStyle = "#182620";
      ctx.lineWidth = 3;
      ctx.strokeText("入口", x + 8, z);
      ctx.fillText("入口", x + 8, z);
    }
    if (this.destination) {
      const [x, z] = pixels(this.destination);
      ctx.beginPath();
      ctx.arc(x, z, 8, 0, Math.PI * 2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#182620";
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#f6d295";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, z, 2, 0, Math.PI * 2);
      ctx.fillStyle = "#f6d295";
      ctx.fill();
    }
  }
}
