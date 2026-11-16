import { compileMap, FlatMap, MiniMap } from "./map.js";
import { tileKey } from "./street-tiles.js";
import { loadReplacements } from "./replacements.js";

const $ = id => document.getElementById(id);
const canvas = $("map");
const terrainHost = $("terrain");
const streetHost = $("street");
const status = $("status");
const search = $("search");
const results = $("results");
const placePanel = $("place");
const checkboxes = ["roads", "places", "buildings"].map($);

function localJson(path) {
  return fetch(path).then(response => {
    if (!response.ok) throw new Error(`${path} · HTTP ${response.status}`);
    return response.json();
  });
}

function message(text) {
  status.textContent = text || "";
  status.hidden = !text;
}

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}

async function start() {
  const params = new URLSearchParams(location.search);
  const replacementsEnabled = params.get("replacements") !== "off";
  const [index, data, catalog] = await Promise.all([
    localJson("./data/index.json"),
    localJson("./data/overview.json"),
    localJson("./data/landmarks/index.json").catch(() => ({ models: [] }))
  ]);
  const replacements = await loadReplacements(index, replacementsEnabled);
  const world = compileMap(data);
  const minimapButton = $("street-minimap");
  const minimap = new MiniMap(minimapButton, world);
  const flightButton = $("street-flight");
  const flightReadout = $("flight-readout");
  const streetKeys = $("street-keys");
  const places = [...index.landmarks.filter(p => p.name && p.point?.length === 2), ...replacements.places];
  const byId = new Map(places.map(place => [place.id, place]));
  const fullModels = new Set(catalog.models.filter(model => model.glb).map(model => model.id));
  const replacementTargets = new Set(replacements.places.map(place => place.id));
  const streetCompare = $("street-compare");
  const compareLabel = replacementsEnabled ? "对照底图建筑" : "查看手工模型";
  const streetTiles = new Set(index.tiles.map(([x, z]) => `${x}_${z}`));
  const { lat, lon } = data.origin;
  const metresPerDegree = Math.PI * 6378137 / 180;
  const metresPerLongitude = metresPerDegree * Math.cos(lat * Math.PI / 180);
  const defaultPlace = { name: "出生点", point: index.spawn };
  const center = [(world.extent.minX + world.extent.maxX) / 2, (world.extent.minZ + world.extent.maxZ) / 2];
  let selected;
  let entrance;
  let destination;
  let mode = "2d";
  let terrain;
  let terrainRequest;
  let street;
  let streetRequest;
  let loadGeneration = 0;

  function geo([x, z]) {
    return [lon + x / metresPerLongitude, lat - z / metresPerDegree];
  }

  function approachPoint(place) {
    if (place.approachAt?.length === 2) return place.approachAt;
    if (place.approach?.length !== 2) return undefined;
    const [lng, latitude] = place.approach;
    return [(lng - lon) * metresPerLongitude, (lat - latitude) * metresPerDegree];
  }

  function streetButton(label, callback) {
    const button = element("button", label, "entrance");
    button.addEventListener("click", callback);
    return button;
  }

  function readout([x, z], resolution) {
    const [lng, latitude] = geo([x, z]);
    $("coordinates").textContent = `${latitude.toFixed(5)}° N · ${lng.toFixed(5)}° E`;
    const scale = $("scale");
    scale.replaceChildren();
    if (!resolution) return;
    const dist = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].findLast(value => value / resolution <= 108) ?? 10;
    const bar = element("i");
    bar.style.width = `${dist / resolution}px`;
    scale.append(bar, dist >= 1000 ? `${dist / 1000} km` : `${dist} m`);
  }

  const flat = new FlatMap(canvas, world, places, select, pickPoint, (point, resolution) => {
    if (mode === "2d") readout(point, resolution);
  });

  function coordinateDetails(point) {
    const [lng, latitude] = geo(point);
    const details = element("dl");
    for (const [label, value] of [
      ["经纬度", `${latitude.toFixed(6)}, ${lng.toFixed(6)}`],
      ["游戏 X / Z", `${point[0].toFixed(2)}, ${point[1].toFixed(2)} m`]
    ]) {
      const row = element("div");
      row.append(element("dt", label), element("dd", value));
      details.append(row);
    }
    return details;
  }

  function hasStreet(point) {
    const [x, z] = point;
    const { minX, maxX, minZ, maxZ } = world.extent;
    if (x < minX || x > maxX || z < minZ || z > maxZ) return false;
    return streetTiles.has(tileKey(...point, index.tileSize));
  }

  function compareUrl(view, id) {
    const url = new URL(location.href);
    url.searchParams.set("view", view);
    url.searchParams.set("id", id);
    if (replacementsEnabled) url.searchParams.set("replacements", "off");
    else url.searchParams.delete("replacements");
    if (view === "street") url.searchParams.set("time", $("street-time").value);
    return url;
  }

  function panel() {
    if (destination) {
      const point = destination;
      placePanel.replaceChildren(element("h1", "已选坐标"), coordinateDetails(point));
      if (hasStreet(point)) {
        const button = streetButton("传送到此处", () => openStreet(point));
        button.classList.add("teleport");
        placePanel.append(button);
      } else {
        placePanel.append(element("p", "此坐标超出街景覆盖范围", "hint"));
      }
      return;
    }
    if (!selected) {
      const { minX, maxX, minZ, maxZ } = world.extent;
      const width = ((maxX - minX) / 1000).toFixed(1);
      const height = ((maxZ - minZ) / 1000).toFixed(1);
      placePanel.replaceChildren(element("h1", data.title),
        element("p", `${places.length} 个地标 · 约 ${width} × ${height} 公里`));
      placePanel.append(streetButton("从地图中心进入街景", () => {
        const target = mode === "3d" ? terrain.controls.target : null;
        openStreet(target ? [target.x, target.z] : flat.origin);
      }));
      return;
    }
    const header = element("h1", selected.name);
    const subtitle = element("p", selected.en);
    placePanel.replaceChildren(header, subtitle, coordinateDetails(entrance ?? selected.point));
    const approach = approachPoint(selected);
    if (approach) {
      const approachLabel = replacementTargets.has(selected.id) ? "定位街景观察点" : "定位原版标注入口";
      placePanel.append(streetButton(entrance ? "返回地标位置" : approachLabel, () => {
        entrance = entrance ? undefined : approach;
        applySelection();
        focus(entrance ?? selected.point, 0.9, 700);
      }));
    }
    placePanel.append(streetButton("进入此处街景", () => {
      const target = selected.point;
      const point = entrance ?? approach ?? [target[0], target[1] + 30];
      openStreet(point, target, selected.id);
    }));
    if (replacementTargets.has(selected.id)) {
      placePanel.append(streetButton("查看地块模型", () => viewModel(selected)));
      if (selected.active) {
        const compare = element("a", compareLabel, "entrance");
        compare.href = compareUrl("model", selected.id).href;
        placePanel.append(compare);
      }
    } else if (fullModels.has(selected.id)) {
      placePanel.append(streetButton("查看原版模型", () => viewModel(selected)));
    }
  }

  function applySelection() {
    flat.selected = selected;
    flat.entrance = entrance;
    flat.destination = destination;
    flat.requestDraw();
    terrain?.select(selected, entrance);
    panel();
  }

  function select(place) {
    if (mode === "2d") {
      loadGeneration++;
      message();
    }
    selected = place;
    entrance = undefined;
    destination = undefined;
    applySelection();
  }

  function pickPoint(point) {
    loadGeneration++;
    message();
    selected = undefined;
    entrance = undefined;
    destination = point;
    applySelection();
  }

  function focus(point, resolution, distance) {
    flat.focus(point, resolution);
    if (mode === "3d") terrain.focus(point, distance);
  }

  function jump(place) {
    select(place);
    if (place) focus(place.point, 1.4, 1100);
    else {
      flat.fit();
      if (mode === "3d") terrain.focus(center, 41500);
    }
  }

  function updateLayers() {
    const [roads, places, buildings] = checkboxes.map(input => input.checked);
    flat.showRoads = roads;
    flat.showPlaces = places;
    flat.requestDraw();
    if (mode === "3d") terrain.setOptions({ roads, places, buildings });
  }

  function setMode(next) {
    if (mode === "street" && next !== "street") street.hide();
    mode = next;
    for (const value of ["2d", "3d", "street"]) {
      $(`mode-${value}`).setAttribute("aria-pressed", String(next === value));
    }
    terrainHost.hidden = next !== "3d";
    streetHost.hidden = next !== "street";
    canvas.hidden = next !== "2d";
    $("north").hidden = next !== "2d";
    $("buildings-option").hidden = next !== "3d";
    $("map-jumps").hidden = next === "street";
    $("street-controls").hidden = next !== "street";
    $("street-hint").hidden = next !== "street";
    minimapButton.hidden = next !== "street";
    $("hint").textContent = {
      "2d": "点击地图选点 · 拖动平移 · 滚轮缩放",
      "3d": "左键旋转 · 右键平移 · 滚轮缩放 · 点击地标",
      street: "W A S D 或方向键移动 · 拖动转头 · Shift 加速"
    }[next];
    panel();
  }

  $("mode-2d").addEventListener("click", () => {
    loadGeneration++;
    if (mode === "3d") {
      const target = terrain.controls.target;
      const distance = terrain.camera.position.distanceTo(target);
      flat.focus([target.x, target.z], distance / Math.max(360, terrainHost.clientHeight));
    } else if (mode === "street") {
      flat.focus([street.camera.position.x, street.camera.position.z], 1.2);
    }
    setMode("2d");
    message();
    flat.requestDraw();
  });
  minimapButton.addEventListener("click", () => $("mode-2d").click());

  async function openTerrain(focusAt) {
    if (mode === "3d") {
      if (focusAt) {
        terrain.select(selected, entrance, false);
        terrain.focus(...focusAt);
      }
      return;
    }
    const generation = ++loadGeneration;
    message("正在加载三维地形和远景建筑…");
    try {
      terrainRequest ??= import("./terrain.js").then(({ TerrainView }) =>
        TerrainView.open(terrainHost, world, places, index, replacements.models, select, readout));
      terrain = await terrainRequest;
      if (generation !== loadGeneration) return;
      const point = mode === "street" ? [street.camera.position.x, street.camera.position.z] : flat.origin;
      const distance = mode === "street" ? 1500 : flat.resolution * Math.max(360, canvas.clientHeight);
      setMode("3d");
      terrain.focus(...(focusAt ?? [point, distance]));
      terrain.select(selected, entrance, !focusAt);
      updateLayers();
      message();
    } catch (error) {
      if (generation !== loadGeneration) return;
      terrainRequest = undefined;
      console.error(error);
      setMode("2d");
      message("三维视图加载失败，可继续使用二维地图。");
    }
  }

  function viewModel(place) {
    const ring = place.clearRings ?? (place.clearRing ? [place.clearRing] : []);
    const radius = Math.max(0, ...ring.flatMap(points => points.map(([x, z]) => Math.hypot(x, z))));
    const height = place.height ?? 12;
    const approach = replacementTargets.has(place.id) ? approachPoint(place) : undefined;
    openTerrain([place.point, Math.max(120, height * 2.45, radius * 2.8), height * 0.39, approach]);
  }

  $("mode-3d").addEventListener("click", () => openTerrain());

  function updateStreetPose(pose) {
    const active = String(pose.flying);
    if (flightButton.getAttribute("aria-pressed") !== active) {
      flightButton.setAttribute("aria-pressed", active);
      streetKeys.textContent = pose.flying
        ? "W A S D 平飞 · 空格升 · Shift 降 · 滚轮调速"
        : "W A S D 移动 · 拖动转头";
    }
    flightReadout.hidden = !pose.flying;
    if (pose.flying) {
      const label = `${pose.speed} m/s · 离地 ${pose.height} m`;
      if (flightReadout.textContent !== label) flightReadout.textContent = label;
    }
    minimap.draw(pose);
  }

  async function openStreet(point, target, selectedId) {
    const generation = ++loadGeneration;
    message("正在读取近景分块…");
    try {
      streetRequest ??= import("./street.js").then(({ StreetView }) =>
        StreetView.open(streetHost, readout, index, replacements.models,
          text => { if (mode === "street") message(text); }, updateStreetPose));
      street = await streetRequest;
      if (generation !== loadGeneration) return;
      const lookHeight = replacementTargets.has(selectedId) ? byId.get(selectedId).height * 0.42 : undefined;
      await street.flyTo(point, target, selectedId, lookHeight);
      if (generation !== loadGeneration) return;
      streetCompare.hidden = !replacementTargets.has(selectedId) || !byId.get(selectedId).active;
      if (!streetCompare.hidden) {
        streetCompare.textContent = compareLabel;
        streetCompare.onclick = () => location.assign(compareUrl("street", selectedId).href);
      }
      setStreetTime(streetTime.valueAsNumber);
      setMode("street");
      message();
      street.show();
      readout([street.camera.position.x, street.camera.position.z], null);
    } catch (error) {
      if (generation !== loadGeneration) return;
      if (!street) streetRequest = undefined;
      console.error(error);
      message("街景分块暂未载入，可以联网后重试。");
    }
  }

  $("mode-street").addEventListener("click", () => { if (mode !== "street") openStreet(); });
  $("street-reset").addEventListener("click", () => openStreet());
  flightButton.addEventListener("click", () => {
    street.toggleFlight();
    street.renderer.domElement.focus({ preventScroll: true });
  });
  const streetTime = $("street-time");
  const nightButton = $("street-night");

  function setStreetTime(minutes) {
    const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mins = String(minutes % 60).padStart(2, "0");
    const label = `${hours}:${mins}`;
    streetTime.value = minutes;
    streetTime.setAttribute("aria-valuetext", label);
    $("street-time-value").textContent = label;
    nightButton.setAttribute("aria-pressed", String(street.setTime(minutes)));
  }

  streetTime.addEventListener("input", () => setStreetTime(streetTime.valueAsNumber));
  nightButton.addEventListener("click", () => {
    const night = nightButton.getAttribute("aria-pressed") !== "true";
    setStreetTime(night ? 23 * 60 + 41 : 14 * 60);
    street.show();
  });

  function zoom(factor) {
    if (mode === "2d") flat.zoom(factor);
    else if (mode === "3d") terrain.zoom(factor);
    else street.zoom(factor);
  }

  $("zoom-in").addEventListener("click", () => zoom(0.72));
  $("zoom-out").addEventListener("click", () => zoom(1.38));
  checkboxes.forEach(input => input.addEventListener("change", updateLayers));
  for (const button of document.querySelectorAll("[data-jump]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.jump;
      search.value = "";
      results.replaceChildren();
      jump(key === "spawn" ? defaultPlace : byId.get(key));
    });
  }

  function useResult(place) {
    search.value = place.name;
    results.replaceChildren();
    jump(place);
  }

  search.addEventListener("input", () => {
    const query = search.value.trim().toLocaleLowerCase();
    results.replaceChildren();
    if (!query) return;
    const all = places.filter(p => [p.name, p.en, p.id].some(text => text?.toLocaleLowerCase().includes(query)));
    all.sort((a, b) => Number(b.name.endsWith(query)) - Number(a.name.endsWith(query)) || a.name.length - b.name.length);
    const matches = all.slice(0, 12);
    if (!matches.length) results.append(element("p", "没有匹配的地标"));
    for (const place of matches) {
      const button = element("button", place.name);
      button.addEventListener("click", () => useResult(place));
      results.append(button);
    }
  });

  search.addEventListener("keydown", event => {
    if (event.key === "Enter") results.querySelector("button")?.click();
    if (event.key === "Escape") {
      search.value = "";
      results.replaceChildren();
    }
  });

  panel();
  flat.fit();
  message();
  const linkedPlace = byId.get(params.get("id"));
  if (params.get("view") === "street") {
    if (linkedPlace) {
      select(linkedPlace);
      const [x, z] = linkedPlace.point;
      const time = params.get("time");
      if (time !== null && /^\d{1,4}$/.test(time) && Number(time) <= 1439) streetTime.value = time;
      else if (replacementTargets.has(linkedPlace.id)) streetTime.value = 14 * 60;
      openStreet(approachPoint(linkedPlace) ?? [x, z + 30], linkedPlace.point, linkedPlace.id);
    } else openStreet();
  }
  if (params.get("view") === "model" && linkedPlace &&
      (fullModels.has(linkedPlace.id) || replacementTargets.has(linkedPlace.id))) {
    const place = linkedPlace;
    select(place);
    viewModel(place);
  }
}

start().catch(error => {
  console.error(error);
  message(`地图加载失败 · ${error.message}`);
});
