// World map categories and ordering from the Nanning Online public 0.8.2 client.
const categoryNames = {
  metro: "地铁站", mall: "商业", culture: "文化", park: "公园", store: "店铺",
  vehicle: "载具", fuel: "加油站", fishing: "钓鱼", transit: "交通枢纽",
  hospital: "医院", campus: "校园 / 社区", bridge: "桥梁", place: "地标"
};
const categoryPatterns = [
  [/医院|卫生院|卫生服务中心/, "hospital"],
  [/钓点|渔具行/, "fishing"],
  [/美又佳|便利店/, "store"],
  [/改车王|摩改|兄弟车行/, "vehicle"],
  [/加油站|WAS\s*石油|WAS\s*石化/, "fuel"],
  [/桥$/, "bridge"],
  [/站$|客运|汽车总站/, "transit"],
  [/公园|森林|景区|青秀山|湖$|游园/, "park"],
  [/学校|中学|大学|校区|小区|社区/, "campus"],
  [/博物馆|文化|艺术|体育|会展|会堂|舞台|影城|电竞|赛车|卡丁车|阁$|塔$|庙$|酒吧街|俱乐部/, "culture"],
  [/广场|万达|万象城|航洋城|天地|酒吧街|酒馆|商业|商场|服装店/, "mall"]
];
const backgroundKinds = new Set(["hospital", "campus", "bridge"]);
const normalized = value => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\s·・()]/g, "");
const distance = (point, origin) => Math.hypot(point[0] - origin[0], point[1] - origin[1]);

export async function loadMapSearchPlaces(index, registered = []) {
  const supplemental = await fetch(new URL("./data/map-search-pois.json", import.meta.url))
    .then(response => response.ok ? response.json() : null).catch(() => null);
  const originals = index.landmarks.map(place => ({ ...place, teleport: true }));
  const registrations = registered.map(place => ({ ...place, registered: true, teleport: true }));
  const extras = supplemental?.baseRevision === index.revision && Array.isArray(supplemental.places) ? supplemental.places : [];
  const places = new Map();
  for (const place of [...registrations, ...originals, ...extras]) {
    if (!place.name || place.point?.length !== 2 || places.has(place.id)) continue;
    const kind = place.kind ?? categoryPatterns.find(([pattern]) => pattern.test(place.name))?.[1] ?? "place";
    places.set(place.id, { ...place, kind, fields: [place.name, place.en, place.id].map(normalized) });
  }
  return [...places.values()];
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function mountMapSearch({ input, chips, list, count, places, origin, onSelect, showSuggestions = false }) {
  let filter = "all";
  let selected = -1;
  let rows = [];
  let expanded = false;
  let limit = 10;
  const categories = [["all", "全部"], ...Object.entries(categoryNames).filter(([kind]) => places.some(place => place.kind === kind))];
  const byBadge = new Map();
  for (const [key, name] of categories) {
    const badge = node("button", name);
    badge.type = "button";
    badge.dataset.kind = key;
    chips.append(badge);
    byBadge.set(key, badge);
    badge.addEventListener("click", () => {
      filter = filter === key ? "all" : key;
      refresh(true);
    });
  }
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  list.setAttribute("role", "listbox");

  function close() {
    expanded = false;
    list.hidden = count.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function choose(place) {
    input.value = place.name;
    close();
    onSelect(place);
  }

  function highlight(next) {
    selected = next;
    for (const [i, row] of rows.entries()) row.setAttribute("aria-selected", String(i === next));
    if (rows[next]) {
      input.setAttribute("aria-activedescendant", rows[next].id);
      rows[next].scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function refresh(show, reset = true) {
    if (reset) limit = 10;
    selected = -1;
    input.removeAttribute("aria-activedescendant");
    const query = normalized(input.value);
    const matches = places.filter(place => !query || place.fields.some(value => value.includes(query)));
    const counts = new Map([["all", matches.length]]);
    for (const place of matches) counts.set(place.kind, (counts.get(place.kind) ?? 0) + 1);
    for (const [key, name] of categories) {
      const badge = byBadge.get(key);
      const total = counts.get(key) ?? 0;
      badge.setAttribute("aria-pressed", String(key === filter));
      badge.textContent = name + " " + total;
      badge.classList.toggle("empty-chip", total === 0);
    }
    if (!show || (!query && filter === "all" && !showSuggestions)) {
      close();
      return;
    }
    const from = typeof origin === "function" ? origin() : origin;
    const candidates = matches.filter(place => filter === "all" || place.kind === filter);
    const rank = place => !place.teleport || backgroundKinds.has(place.kind);
    candidates.sort((a, b) =>
      Number(query && b.fields[0] === query) - Number(query && a.fields[0] === query) ||
      Number(b.registered || false) - Number(a.registered || false) ||
      Number(b.teleport || false) - Number(a.teleport || false) ||
      Number(rank(a)) - Number(rank(b)) || distance(a.point, from) - distance(b.point, from));

    list.replaceChildren();
    rows = candidates.slice(0, limit).map((place, i) => {
      const row = node("button", undefined, "map-search-result");
      row.type = "button";
      row.id = `${list.id}-option-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      const title = node("span", undefined, "map-search-name");
      title.append(node("strong", place.name));
      if (place.en) title.append(node("small", place.en));
      row.append(title, node("span", place.registered ? "已有目标" : categoryNames[place.kind], "map-search-tag"));
      row.addEventListener("click", () => choose(place));
      list.append(row);
      return row;
    });
    if (!rows.length) list.append(node("p", "没有匹配的地点。试试全名、简称或切换分类。"));
    if (candidates.length > limit) {
      const more = node("button", "展开更多地点", "map-search-more");
      more.type = "button";
      more.addEventListener("click", () => {
        limit += 20;
        refresh(true, false);
        rows[limit - 20]?.focus();
      });
      list.append(more);
    }
    count.textContent = `${candidates.length} 处地点`;
    expanded = true;
    input.setAttribute("aria-expanded", "true");
    list.hidden = count.hidden = false;
  }

  input.addEventListener("input", () => refresh(true));
  input.addEventListener("focus", () => refresh(true));
  input.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!expanded) refresh(true);
      if (!rows.length || !expanded) return;
      event.preventDefault();
      const next = event.key === "ArrowDown" ? selected + 1 : selected < 0 ? rows.length - 1 : selected - 1;
      highlight((next + rows.length) % rows.length);
    } else if (event.key === "Enter" && expanded && rows.length) {
      event.preventDefault();
      (rows[selected] ?? rows[0]).click();
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "/" || event.altKey || event.ctrlKey || event.metaKey || event.isComposing ||
        !input.getClientRects().length || event.target.closest?.("input, textarea, select, [contenteditable]")) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
  refresh(Boolean(input.value));
  input.disabled = false;
  return { clear() { input.value = ""; filter = "all"; refresh(false); } };
}
