import { loadMapSearchPlaces, mountMapSearch } from "/map-search.js";
import { setupTutorial } from "./tutorial.js";

const api = "/api/workshop/";
const byId = id => document.getElementById(id);
const statuses = {
  pending: "待审核", approved: "接受（待移植）", completed: "已完成",
  changes_requested: "退修", rejected: "已拒绝", withdrawn: "已撤回"
};
const stages = { ...statuses, awaiting_agent: "待 Agent 初审", awaiting_review: "待复核", in_review: "待复核" };
const decisions = { approved: "接受", changes_requested: "退修", rejected: "拒绝" };
const stageLabel = item => stages[item.stage] || statuses[item.status];
const portingBlocked = item => item.status === "approved" && item.portingBlock && item.portingBlock.resolvedAt == null;
const recommendations = { approved: "建议通过", changes_requested: "建议退修", rejected: "建议拒绝" };
const proofLabels = { "real-world": "实景参考图", model: "独立模型图", "in-map": "导入验证图", changes: "改动说明" };
const packageUrl = id => api + "packages/" + id;
const score = report => `${report.reviewScore} / ${report.maxScore}`;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function stateBadge(item) {
  const badge = element("span", stageLabel(item), "badge state-badge");
  badge.dataset.state = item.stage === "in_review" ? "awaiting_review" : item.stage ?? item.status;
  return badge;
}

function stateIndicators(item) {
  const indicators = element("span", undefined, "state-indicators");
  indicators.append(stateBadge(item));
  if (portingBlocked(item)) indicators.append(element("span", "移植受阻", "porting-flag"));
  return indicators;
}

function link(text, href, className = "button quiet small") {
  const node = element("a", text, className);
  node.href = href;
  return node;
}

function feedback(node, text = "", error = false) {
  node.textContent = text;
  node.classList.toggle("error", error);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (response.status === 401 && result.error?.code === "signin" && document.body.dataset.page !== "login") {
    location.replace("/workshop/login");
  }
  if (!response.ok) throw new Error(result.error?.message || `请求失败（HTTP ${response.status}）`);
  return result;
}

function post(url, body, contentType) {
  return request(url, { method: "POST", body, headers: { "Content-Type": contentType, "X-Workshop-Request": "1" } });
}

async function copy(text, node, confirmation) {
  try {
    await navigator.clipboard.writeText(text);
    feedback(node, confirmation);
  } catch {
    feedback(node, "无法访问剪贴板，可选中下方文字手动复制。", true);
    return false;
  }
  return true;
}

function displayDate(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai"
  }).format(timestamp);
}

function setupLogin() {
  const form = byId("login-form");
  const options = byId("demo-accounts");
  const submit = byId("login-submit");
  const status = byId("login-feedback");
  request(api + "auth/options").then(accounts => {
    for (const [i, account] of accounts.entries()) {
      const label = element("label", undefined, "demo-option");
      const input = element("input");
      const name = element("span", undefined, "demo-name");
      input.type = "radio";
      input.name = "account";
      input.value = account.id;
      input.checked = i === 0;
      input.required = true;
      name.append(element("strong", account.name),
        element("small", account.role === "developer" ? "查看和处理全站审核工单" : "创建投稿并查看自己的审核进度"));
      label.append(input, name, element("span", account.role === "developer" ? "开发者" : "玩家", "demo-role"));
      options.append(label);
    }
    submit.disabled = !accounts.length;
  }).catch(error => feedback(status, error.message, true));

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const account = new FormData(form).get("account");
    if (!account) return;
    submit.disabled = options.disabled = true;
    feedback(status, "正在登录…");
    try {
      const params = new URLSearchParams(location.search);
      const tutorial = params.get("tutorial") === "1";
      const { next } = await post(api + "auth/login",
        JSON.stringify({ account, tutorial, package: params.get("package") }), "application/json");
      location.replace(next);
    } catch (error) {
      feedback(status, error.message, true);
      submit.disabled = options.disabled = false;
    }
  });
}

function setupSession() {
  for (const logout of document.querySelectorAll("[data-logout]")) {
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      try {
        const { next } = await post(api + "auth/logout", "{}", "application/json");
        location.replace(next);
      } catch {
        logout.disabled = false;
        logout.textContent = "重试退出";
      }
    });
  }
  return request(api + "session").then(account => {
    document.querySelectorAll("[data-account-name]").forEach(node => { node.textContent = account.name; });
    const description = byId("account-description");
    if (description) description.textContent = account.name + " · 查看交付包的审核进度和审核意见。";
    return account;
  }).catch(() => null);
}

function setupGuide() {
  const search = byId("place-search");
  const searchFeedback = byId("search-feedback");
  const placeFeedback = byId("place-feedback");
  const copyPlace = byId("copy-place");
  const name = byId("place-name");
  const picker = byId("map-picker");
  const frame = byId("picker-frame");
  const prompt = byId("prompt");
  const promptFeedback = byId("prompt-feedback");
  let city;
  let draft;
  let searchControl;
  let picking;
  let promptRequest;

  function currentPlace() {
    const title = name.value.trim();
    if (!title || !draft?.point || !draft.approachAt ||
        Math.hypot(draft.point[0] - draft.approachAt[0], draft.point[1] - draft.approachAt[1]) < 0.01) return;
    return { ...draft, name: title, baseRevision: city.revision };
  }

  function updatePlace() {
    byId("place-editor").hidden = !draft;
    copyPlace.disabled = !currentPlace();
    if (draft) {
      const labels = [[name.readOnly ? "登记锚点" : "锚点", draft.point], ["观察点", draft.approachAt]];
      byId("points").textContent = labels.map(([label, point]) => `${label} ${point ? point.join(" / ") + " m" : "未选择"}`).join(" · ");
    }
    feedback(placeFeedback);
  }

  function gameApproach(place) {
    if (place.approachAt?.length === 2) return place.approachAt;
    if (place.approach?.length === 2) {
      const [lon, lat] = place.approach;
      const metres = Math.PI * 6378137 / 180;
      const [x, z] = [(lon - city.origin.lon) * metres * Math.cos(city.origin.lat * Math.PI / 180),
        (city.origin.lat - lat) * metres];
      const size = city.tileSize;
      if (city.tiles.some(([ix, iz]) => ix === Math.floor(x / size) && iz === Math.floor(z / size))) {
        return [x, z].map(value => Number(value.toFixed(2)));
      }
    }
  }

  function choosePlace(place) {
    const newTarget = "workshop-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    draft = { target: place?.registered ? place.id : newTarget };
    name.value = place?.name ?? "";
    name.readOnly = Boolean(place?.registered);
    byId("pick-anchor").disabled = Boolean(place?.registered);
    if (place) {
      const { id, point, height, active } = place;
      draft.point = point;
      draft.approachAt = gameApproach(place);
      if (height) draft.height = height;
      if (place.registered) draft.currentVersion = active;
      else draft.reference = { gamePlaceId: id };
    }
    updatePlace();
    if (place && copyPlace.disabled) feedback(placeFeedback, "请在地图上选择一个有街景的观察点。");
  }

  Promise.all([request("/data/index.json"), request("/data/replacements/index.json")]).then(async ([index, release]) => {
    city = index;
    const registered = release.baseRevision === city.revision ? release.targets : [];
    searchControl = mountMapSearch({
      input: search, chips: byId("place-chips"), list: byId("place-results"), count: byId("place-count"),
      places: await loadMapSearchPlaces(city, registered), origin: () => draft?.point ?? city.spawn,
      onSelect: choosePlace, showSuggestions: true
    });
    search.disabled = byId("manual-place").disabled = false;
  }).catch(error => feedback(searchFeedback, error.message, true));
  byId("jump-to-place").addEventListener("click", () => search.focus());
  name.addEventListener("input", updatePlace);

  function openPicker(key, label) {
    picking = key;
    byId("picker-title").textContent = label;
    const params = new URLSearchParams({ "workshop-pick": "1" });
    const center = draft[key] ?? draft.point;
    if (center) params.set("pick-center", center.join(","));
    const path = "/?" + params;
    if (frame.getAttribute("src") !== path) frame.src = path;
    picker.showModal();
  }

  byId("manual-place").addEventListener("click", () => {
    searchControl.clear();
    choosePlace();
    openPicker("point", "选建筑锚点");
  });
  for (const [id, key, label] of [["pick-anchor", "point", "选建筑锚点"], ["pick-approach", "approachAt", "选街景观察点"]]) {
    byId(id).addEventListener("click", () => openPicker(key, label));
  }
  byId("close-picker").addEventListener("click", () => picker.close());
  window.addEventListener("message", event => {
    if (!picker.open || event.source !== frame.contentWindow || event.origin !== location.origin ||
        event.data?.type !== "workshop-point") return;
    const { point, hasStreet, latitude, longitude } = event.data;
    if (picking === "approachAt" && !hasStreet) {
      byId("picker-title").textContent = "此处没有街景覆盖，请重新选点";
      return;
    }
    const other = picking === "point" ? draft.approachAt : draft.point;
    if (other && Math.hypot(point[0] - other[0], point[1] - other[1]) < 0.01) {
      byId("picker-title").textContent = "请选择与另一坐标不同的位置";
      return;
    }
    draft[picking] = point;
    if (picking === "point") draft.reference = { ...draft.reference, latitude, longitude };
    picker.close();
    updatePlace();
  });
  copyPlace.addEventListener("click", async () => {
    const text = JSON.stringify(currentPlace(), null, 2);
    if (!await copy(text, placeFeedback, "地点资料已复制")) {
      const pre = element("pre", text, "prompt");
      placeFeedback.append(pre);
    }
  });

  const viewPrompt = byId("view-prompt");
  function setPromptVisible(visible) {
    prompt.hidden = !visible;
    viewPrompt.textContent = visible ? "收起详情" : "展开查看";
    viewPrompt.setAttribute("aria-expanded", String(visible));
  }
  async function getPrompt() {
    promptRequest ??= request(api + "guide").catch(error => {
      promptRequest = undefined;
      throw error;
    });
    const result = await promptRequest;
    prompt.textContent = result.prompt;
    return result.prompt;
  }
  viewPrompt.setAttribute("aria-controls", "prompt");
  setPromptVisible(false);
  viewPrompt.addEventListener("click", async () => {
    try {
      await getPrompt();
      setPromptVisible(prompt.hidden);
    } catch (error) {
      feedback(promptFeedback, error.message, true);
    }
  });
  byId("copy-prompt").addEventListener("click", async () => {
    try {
      const text = await getPrompt();
      if (!await copy(text, promptFeedback, "Agent Prompt 已复制")) setPromptVisible(true);
    } catch (error) {
      feedback(promptFeedback, error.message, true);
    }
  });
}

function setupUpload() {
  const form = byId("upload-form");
  const input = byId("package");
  const drop = byId("drop-zone");
  const submit = byId("submit");
  const example = byId("use-example");
  const status = byId("upload-feedback");
  const result = byId("result");
  const revisionId = new URLSearchParams(location.search).get("revision");
  const submitUrl = revisionId ? packageUrl(revisionId) + "/revision" : api + "packages";
  let revisionReady = !revisionId;
  let file;
  let uploading = false;

  function updateSubmit() {
    submit.disabled = !file || uploading || !revisionReady;
  }

  if (revisionId) {
    const context = byId("revision-context");
    context.hidden = false;
    example.hidden = true;
    context.append(element("p", "正在读取退修工单…"));
    const original = /^[a-f0-9]{32}$/.test(revisionId)
      ? request(packageUrl(revisionId)) : Promise.reject(new Error("工单编号无效，请返回我的投稿。"));
    original.then(item => {
      if (item.status !== "changes_requested" || item.history[0]?.id !== item.id) {
        throw new Error("请从我的投稿打开当前待修订的工单。");
      }
      context.replaceChildren(element("strong", `提交第 ${item.revisionNumber + 1} 版 · ${item.place.name}`),
        element("p", "前一版审核意见　" + (item.decisions[0]?.note || "请查看原工单")),
        link("返回我的投稿", "/workshop/account", "text-button"));
      submit.textContent = "校验并提交修订版";
      if (item.place.id === "nn14-jianzheng" && item.revisionNumber === 1) {
        example.textContent = "选用十四中修订演示包";
        example.hidden = false;
      }
      revisionReady = true;
      updateSubmit();
    }).catch(error => {
      context.replaceChildren(element("p", error.message, "warning"),
        link("返回我的投稿", "/workshop/account", "text-button"));
    });
  }

  function choose(selected) {
    result.hidden = true;
    file = undefined;
    if (selected && /\.zip$/i.test(selected.name) && selected.size > 0 && selected.size <= 48 * 1024 * 1024) {
      file = selected;
      feedback(status);
    } else if (selected) {
      feedback(status, "请选择 48 MiB 以内的非空 ZIP。", true);
    }
    byId("filename").textContent = file?.name || "拖放 ZIP 文件到这里";
    byId("filesize").textContent = file ? `${(file.size / 1024 / 1024).toFixed(2)} MiB` : "仅支持 .zip · 最大 48 MiB";
    updateSubmit();
  }

  input.addEventListener("change", () => choose(input.files[0]));
  drop.addEventListener("dragover", event => {
    event.preventDefault();
    if (!uploading) drop.classList.add("dragging");
  });
  drop.addEventListener("dragleave", event => {
    if (!drop.contains(event.relatedTarget)) drop.classList.remove("dragging");
  });
  drop.addEventListener("drop", event => {
    event.preventDefault();
    drop.classList.remove("dragging");
    if (!uploading) choose(event.dataTransfer.files[0]);
  });
  example.addEventListener("click", async () => {
    example.disabled = true;
    try {
      const response = await fetch(revisionId ? "/workshop/example-revision.zip" : "/workshop/example.zip");
      if (!response.ok) throw new Error("示例包暂时无法读取");
      const filename = revisionId ? "nn14-jianzheng-revision-demo.zip" : "nn14-jianzheng-1.0.0.zip";
      choose(new File([await response.blob()], filename, { type: "application/zip" }));
    } catch (error) {
      feedback(status, error.message, true);
    } finally {
      example.disabled = false;
    }
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!file || uploading || !revisionReady) return;
    uploading = true;
    submit.disabled = input.disabled = example.disabled = true;
    result.hidden = true;
    feedback(status, "正在上传并检查文件…");
    try {
      const item = await post(submitUrl, file, "application/zip");
      const copyReceipt = element("button", "复制工单编号", "text-button");
      copyReceipt.type = "button";
      copyReceipt.addEventListener("click", () => copy(item.ticketId, status, "工单编号已复制"));
      result.replaceChildren(
        element("strong", item.duplicate ? "已有投稿" : "校验通过"),
        stateBadge(item),
        element("p", `${item.place.name} · 第 ${item.revisionNumber} 版 · 材料得分 ${score(item.report)}`),
        element("p", `工单编号 ${item.ticketId}`),
        ...item.report.warnings.map(warning => element("p", warning, "warning")),
        copyReceipt,
        link("前往我的投稿", "/workshop/account", "text-button receipt-link")
      );
      result.hidden = false;
      byId("receipt").value = item.ticketId;
      feedback(status);
    } catch (error) {
      feedback(status, "预校验退回。 " + error.message, true);
    } finally {
      uploading = false;
      updateSubmit();
      input.disabled = example.disabled = false;
    }
  });

  byId("lookup-form").addEventListener("submit", async event => {
    event.preventDefault();
    const note = byId("lookup-feedback");
    const id = byId("receipt").value.trim();
    if (!/^[a-f0-9]{32}$/.test(id)) {
      feedback(note, "请输入完整的 32 位工单编号。", true);
      return;
    }
    try {
      const item = await request(packageUrl(id) + "/ticket");
      const reason = item.withdrawal ? item.withdrawal.note : portingBlocked(item) ? "移植受阻：" + item.portingBlock.reason : item.note;
      feedback(note, `${item.place.name} · 第 ${item.revisionNumber} 版 · ${stageLabel(item)}${reason ? " · " + reason : ""}`);
    } catch (error) {
      feedback(note, error.message, true);
    }
  });
}

function previewLink(item, view, baseline, label, from = "review") {
  const params = new URLSearchParams({ view, id: item.place.id, candidate: item.id, from });
  if (baseline) params.set("replacements", "off");
  const anchor = link(label, "/?" + params);
  anchor.target = "_blank";
  anchor.rel = "noopener";
  return anchor;
}

function detailSection(container, title) {
  const section = element("section", undefined, "detail-section");
  section.append(element("h3", title));
  container.append(section);
  return section;
}

function revisionHistory(item, openRevision) {
  const history = element("details", undefined, "revision-history");
  history.append(element("summary", `修订记录（${item.history.length} 版）`));
  for (const version of item.history) {
    const row = element("div", undefined, "revision-entry");
    const head = element("div", undefined, "revision-entry-head");
    head.append(element("strong", `第 ${version.number} 版 · 模型 v${version.version}`), stateBadge(version));
    row.append(head, element("small", `${version.id === item.id ? "当前查看 · " : ""}${displayDate(version.createdAt)}`));
    if (version.note) row.append(element("p", version.note));
    if (version.id !== item.id) {
      if (openRevision) {
        const open = element("button", "查看这一版", "text-button");
        open.type = "button";
        open.addEventListener("click", () => openRevision(version.id));
        row.append(open);
      } else {
        row.append(link("下载这版 ZIP", packageUrl(version.id) + "/download", "text-button"));
      }
    }
    history.append(row);
  }
  return history;
}

function setupAccount() {
  const list = byId("my-submissions");
  const status = byId("account-feedback");
  const filters = [...document.querySelectorAll("[data-mine]")];
  let items = [];
  let active = "all";
  const matches = (item, key) => key === "all" || (key === "other"
    ? ["changes_requested", "rejected", "withdrawn"].includes(item.status) : item.status === key);
  const dialog = byId("withdraw-dialog");
  const note = byId("withdraw-note");
  const confirm = byId("confirm-withdraw");
  const cancel = byId("cancel-withdraw");
  const dialogMessage = byId("withdraw-feedback");
  let selected;

  function openWithdrawal(item) {
    selected = item;
    note.value = "";
    byId("withdraw-target").textContent = item.place.name;
    feedback(dialogMessage);
    dialog.showModal();
  }

  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", event => { if (confirm.disabled) event.preventDefault(); });
  byId("withdraw-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!selected || confirm.disabled) return;
    confirm.disabled = cancel.disabled = true;
    try {
      await post(packageUrl(selected.id) + "/withdraw", JSON.stringify({ note: note.value }), "application/json");
      dialog.close();
      active = "other";
      await refresh();
      if (!status.textContent) feedback(status, "工单已撤回。");
    } catch (error) {
      feedback(dialogMessage, error.message, true);
    } finally {
      confirm.disabled = cancel.disabled = false;
    }
  });

  function render() {
    for (const button of filters) {
      const key = button.dataset.mine;
      button.setAttribute("aria-pressed", String(key === active));
      button.querySelector("strong").textContent = items.filter(item => matches(item, key)).length;
    }
    list.replaceChildren();
    const visible = items.filter(item => matches(item, active));
    if (visible.length === 0) {
      list.append(element("p", items.length ? "此状态下没有投稿。" : "还没有投稿。首次提交后，可以在这里查看进度。", "account-empty"));
      return;
    }
    for (const item of visible) {
      const card = element("article", undefined, "my-package");
      const title = element("div", undefined, "detail-head");
      const names = element("div");
      names.append(
        element("h2", item.place.name),
        element("p", `第 ${item.revisionNumber} 版 · 模型 v${item.place.active} · 材料 ${score(item.report)} · ${displayDate(item.createdAt)}`),
        element("p", "工单编号 " + item.ticketId)
      );
      title.append(names, stateIndicators(item));
      card.append(title);
      if (item.note) card.append(element("p", "审核意见　" + item.note, "my-review-note"));
      if (item.completion?.note) card.append(element("p", "移植说明　" + item.completion.note, "my-review-note"));
      if (item.withdrawal) {
        card.append(element("p", `撤回于 ${displayDate(item.withdrawal.at)}${item.withdrawal.note ? " · " + item.withdrawal.note : ""}`, "my-review-note"));
      }
      if (portingBlocked(item)) card.append(element("p", "移植阻塞原因　" + item.portingBlock.reason, "my-review-note"));
      const controls = element("div", undefined, "preview-links");
      const copyReceipt = element("button", "复制工单编号", "text-button");
      copyReceipt.type = "button";
      copyReceipt.addEventListener("click", () => copy(item.ticketId, status, "工单编号已复制"));
      controls.append(previewLink(item, "model", false, "查看我的模型 ↗", "account"),
        link("下载 ZIP", packageUrl(item.id) + "/download"), copyReceipt);
      if (item.stage === "changes_requested") {
        controls.prepend(link("提交修订版", `/workshop/?revision=${item.id}#submit-package`, "button primary small"));
      }
      if (["pending", "changes_requested", "approved"].includes(item.status)) {
        const withdraw = element("button", "撤回工单", "text-button muted");
        withdraw.type = "button";
        withdraw.addEventListener("click", () => openWithdrawal(item));
        controls.append(withdraw);
      }
      card.append(controls);
      if (item.history?.length > 1) card.append(revisionHistory(item));
      list.append(card);
    }
  }

  for (const filter of filters) {
    filter.addEventListener("click", () => {
      active = filter.dataset.mine;
      render();
    });
  }
  async function refresh() {
    feedback(status, "正在读取我的投稿…");
    try {
      items = await request(api + "my-submissions");
      feedback(status);
      render();
    } catch (error) {
      feedback(status, error.message, true);
    }
  }
  refresh();
}

function renderPortingBlock(section, item, refreshItem) {
  const block = item.portingBlock;
  const active = portingBlocked(item);
  if (block) {
    const card = element("div", undefined, "porting-block");
    card.append(
      element("strong", active ? "移植受阻" : "上次移植阻塞"),
      element("p", block.reason),
      element("p", `${block.name} · ${displayDate(block.at)}`)
    );
    if (block.resolvedAt != null) {
      card.append(element("p", `结束记录　${block.resolvedBy} · ${displayDate(block.resolvedAt)}`));
    }
    section.append(card);
  }
  if (item.status !== "approved") return;
  const form = element("form", undefined, "decision-form block-form");
  const note = element("textarea");
  note.id = "blocker-note";
  note.rows = 2;
  note.required = true;
  note.maxLength = 1000;
  if (!active) {
    const label = element("label", "阻塞原因（投稿者可见）");
    label.htmlFor = note.id;
    form.append(label, note);
  }
  const action = element("button", active ? "解除阻塞" : "标记移植受阻", "button quiet small");
  const message = element("p", undefined, "feedback");
  message.setAttribute("aria-live", "polite");
  form.append(action, message);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    action.disabled = true;
    try {
      const operation = active ? "/unblock-porting" : "/block-porting";
      await post(packageUrl(item.id) + operation, JSON.stringify({ note: note.value }), "application/json");
      await refreshItem(item.id, "porting");
    } catch (error) {
      feedback(message, error.message, true);
      action.disabled = false;
    }
  });
  section.append(form);
}

function renderCompletion(detail, item, refreshItem) {
  const section = detailSection(detail, "移植记录");
  renderPortingBlock(section, item, refreshItem);
  if (item.completion) {
    section.append(element("p", `${item.completion.name} · ${displayDate(item.completion.at)}`));
    if (item.completion.note) section.append(element("p", item.completion.note));
    return;
  }
  if (item.status !== "approved") return;
  section.append(element("p", portingBlocked(item)
    ? "记录移植完成会一并结束当前阻塞。"
    : "完成地图移植和验证后记录。可填写目标版本或验证结果。"));
  const form = element("form", undefined, "decision-form");
  const label = element("label", "移植说明（选填）");
  const note = element("textarea");
  const record = element("button", "记录移植完成", "button primary small");
  const feedbackNode = element("p", undefined, "feedback");
  label.htmlFor = note.id = "completion-note";
  note.rows = 2;
  note.maxLength = 1000;
  feedbackNode.setAttribute("aria-live", "polite");
  form.append(label, note, record, feedbackNode);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    record.disabled = true;
    try {
      await post(packageUrl(item.id) + "/complete", JSON.stringify({ note: note.value }), "application/json");
      await refreshItem(item.id, "handled");
    } catch (error) {
      feedback(feedbackNode, error.message, true);
      record.disabled = false;
    }
  });
  section.append(form);
}

function renderDetail(detail, item, { reviewer, refreshItem, openRevision }) {
  const { place, report, manifest } = item;
  const title = element("div");
  title.append(element("h2", place.name),
    element("p", `第 ${item.revisionNumber} 版 · 模型 v${place.active} · ${displayDate(item.createdAt)}`),
    element("p", `工单编号 ${item.ticketId}`));
  const header = element("header", undefined, "detail-head");
  header.append(title, stateIndicators(item));
  detail.replaceChildren(header);
  const latest = item.history[0]?.id === item.id;
  const assigned = item.claim?.id === reviewer.id;
  const assignment = detailSection(detail, "工单进度");
  if (!latest) {
    assignment.append(element("p", "这是历史版本。"), revisionHistory(item, openRevision));
  } else if (item.stage === "awaiting_agent") {
    assignment.append(element("p", "等待 Agent 给出初步结论。初审写回后，工单会进入人工复核队列。"));
    const prompt = element("button", "复制初审指令", "button quiet small");
    const feedbackNode = element("p", undefined, "feedback");
    prompt.type = "button";
    prompt.addEventListener("click", () => copy(
      `请用工坊审稿 MCP 初审投稿 ${item.id}。核对模型加载与变更、位置朝向与旧楼遮罩、实景依据和发布授权。用 save_review_suggestion 保存建议结论、已检查的证据以及仍需人工确认的问题。`,
      feedbackNode, "初审指令已复制"
    ));
    assignment.append(prompt, feedbackNode);
  } else if (item.status === "pending") {
    assignment.append(element("p", item.claim ? `处理人　${item.claim.name} · ${displayDate(item.claim.at)}`
      : "Agent 已完成初审，认领后可提交人工复核结论。"));
    if (!item.claim || assigned) {
      const release = Boolean(item.claim);
      const button = element("button", release ? "释放工单" : "认领工单", release ? "button quiet small" : "button primary small");
      const message = element("p", undefined, "feedback");
      button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await post(packageUrl(item.id) + (release ? "/release" : "/claim"), "{}", "application/json");
          await refreshItem(item.id, release ? "human" : "mine");
        } catch (error) {
          feedback(message, error.message, true);
          button.disabled = false;
        }
      });
      assignment.append(button, message);
    }
  } else if (item.withdrawal) {
    assignment.append(element("p", `投稿者撤回 · ${displayDate(item.withdrawal.at)}`));
    if (item.withdrawal.note) assignment.append(element("p", item.withdrawal.note));
  } else if (item.claim) {
    assignment.append(element("p", `复核人　${item.claim.name}`));
  }
  if (latest && item.history.length > 1) assignment.append(revisionHistory(item, openRevision));
  if (item.reviewSuggestions?.length) {
    const advisory = detailSection(detail, "Agent 初审");
    for (const suggestion of item.reviewSuggestions) {
      const block = element("article", undefined, "agent-suggestion");
      block.append(element("strong", recommendations[suggestion.recommendation]),
        element("small", displayDate(suggestion.at)), element("p", suggestion.note));
      advisory.append(block);
    }
  }

  const preview = detailSection(detail, "地图对照");
  const links = element("div", undefined, "preview-links");
  links.append(previewLink(item, "model", false, "候选模型 ↗"), previewLink(item, "model", true, "原底图 · 三维 ↗"),
    previewLink(item, "street", false, "候选街景 ↗"), previewLink(item, "street", true, "原底图 · 街景 ↗"));
  preview.append(links, element("p", "各组链接共用同一落位坐标及观察机位。"));

  const proof = detailSection(detail, "审核材料 " + score(report));
  const checklist = element("div", undefined, "proof-list");
  for (const [key, label] of Object.entries(proofLabels)) {
    checklist.append(element("div", `${report.evidence[key] ? "✓" : "○"} ${label}`, report.evidence[key] ? "proof valid" : "proof"));
  }
  proof.append(checklist);
  if (item.images.length) {
    const gallery = element("div", undefined, "evidence-grid");
    for (const path of item.images) {
      const url = packageUrl(item.id) + "/image?" + new URLSearchParams({ name: path });
      const imageLink = link(undefined, url, "evidence-image");
      imageLink.target = "_blank";
      imageLink.rel = "noopener";
      const image = element("img");
      image.src = url;
      image.alt = path.split("/").at(-1);
      image.loading = "lazy";
      imageLink.append(image, element("span", path));
      gallery.append(imageLink);
    }
    proof.append(gallery);
  }
  for (const warning of report.warnings) proof.append(element("p", warning, "warning"));
  if (item.changes) {
    const notes = element("details");
    notes.append(element("summary", "查看改动说明"), element("pre", item.changes, "changes"));
    proof.append(notes);
  }

  const metadata = detailSection(detail, "模型与授权");
  const fields = element("dl", undefined, "detail-fields");
  for (const [label, value] of [
    ["投稿账号", item.owner?.name || "历史投稿"],
    ["底图版本", manifest.baseRevision],
    ["锚点 X / Z / 偏移", manifest.placement.anchor.join(" / ") + " m"],
    ["朝向 / 比例", `${manifest.placement.yaw}° / ${manifest.placement.scale}`],
    ["作者", manifest.source.author],
    ["来源", manifest.source.repository || manifest.source.description],
    ["权利说明", item.submission.rights.statement],
    ["ZIP SHA-256", item.digest]
  ]) fields.append(element("dt", label), element("dd", value));
  metadata.append(fields, link("下载交付包 ↓", packageUrl(item.id) + "/download"));
  const review = detailSection(detail, "审核结论");
  if (item.status !== "pending") {
    const decision = item.decisions[0];
    const record = [decisions[decision?.status], decision?.reviewer_name, decision && displayDate(decision.at)].filter(Boolean);
    review.append(element("p", record.length ? record.join(" · ") : "暂无人工审核结论。"));
    if (decision?.note) review.append(element("p", decision.note));
    if (item.status === "approved" || item.status === "completed" || item.portingBlock) renderCompletion(detail, item, refreshItem);
    return;
  }
  if (!assigned) {
    review.append(element("p", item.claim ? "由认领者提交正式结论。" : "认领工单后可提交正式结论。"));
    return;
  }
  review.append(element("p", "复核提示：核对地图落位和旧楼遮罩、实景依据及发布授权。退修意见请指出要补的材料。"));
  const form = element("form", undefined, "decision-form");
  const selectRow = element("div");
  const selectLabel = element("label", "结论");
  const select = element("select");
  select.id = selectLabel.htmlFor = "decision-status";
  select.required = true;
  select.add(new Option("请选择结论", ""));
  for (const [key, label] of Object.entries(decisions)) select.add(new Option(label, key));
  selectRow.append(selectLabel, select);
  const noteRow = element("div");
  const noteLabel = element("label", "给投稿者的说明");
  const note = element("textarea");
  note.id = noteLabel.htmlFor = "decision-note";
  note.rows = 3;
  note.maxLength = 1000;
  note.placeholder = "退修或拒绝时填写原因";
  noteRow.append(noteLabel, note);
  const record = element("button", "记录审核结论", "button primary small");
  const message = element("p", undefined, "feedback");
  message.setAttribute("aria-live", "polite");
  form.append(selectRow, noteRow, record, message);
  select.addEventListener("change", () => { note.required = ["changes_requested", "rejected"].includes(select.value); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    record.disabled = true;
    try {
      await post(packageUrl(item.id) + "/decision", JSON.stringify({ status: select.value, note: note.value }), "application/json");
      await refreshItem(item.id, select.value === "approved" ? "porting" : "handled");
    } catch (error) {
      feedback(message, error.message, true);
      record.disabled = false;
    }
  });
  review.append(form);
}

function setupReview(account) {
  const queue = byId("queue");
  const detail = byId("detail");
  const message = byId("queue-feedback");
  let filter = "human";
  let reviewer;
  let list = [];
  let selected;
  let requestNumber = 0;
  function matches(item, key) {
    if (key === "all") return true;
    if (key === "agent") return item.stage === "awaiting_agent";
    if (key === "mine") return item.status === "pending" && item.claim?.id === reviewer?.id;
    if (key === "human") return item.stage === "awaiting_review" || item.stage === "in_review";
    if (key === "porting") return item.status === "approved";
    return item.status !== "pending" && item.status !== "approved";
  }

  function renderQueue() {
    queue.replaceChildren();
    const items = list.filter(item => matches(item, filter));
    byId("queue-count").textContent = items.length;
    if (!items.length) {
      queue.append(element("p", "当前没有符合条件的工单。", "empty"));
      return;
    }
    for (const item of items) {
      const row = element("button", undefined, "queue-item");
      row.type = "button";
      if (item.id === selected) row.setAttribute("aria-current", "true");
      const text = element("span");
      text.append(element("strong", item.place.name),
        element("small", `${item.owner?.name || "历史投稿"} · 第 ${item.revisionNumber} 版 · ${displayDate(item.createdAt)}`));
      if (item.claim && item.status === "pending") text.append(element("small", "认领人 " + item.claim.name, "queue-advice"));
      const summary = element("span", undefined, "queue-state");
      summary.append(stateIndicators(item), element("b", score(item.report)));
      row.append(text, summary);
      row.addEventListener("click", () => pick(item.id));
      queue.append(row);
    }
  }

  async function pick(id) {
    selected = id;
    const ticket = ++requestNumber;
    renderQueue();
    detail.replaceChildren(element("p", id ? "正在读取交付包…" : "从队列选择一份投稿，查看地图预览和审核材料。", "empty"));
    if (!id) return;
    try {
      const item = await request(packageUrl(id));
      if (ticket === requestNumber) renderDetail(detail, item, { reviewer, refreshItem: refresh, openRevision: pick });
    } catch (error) {
      if (ticket === requestNumber) detail.replaceChildren(element("p", error.message, "warning"));
    }
  }

  function renderFilters() {
    document.querySelectorAll("[data-filter]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
    });
  }

  function firstVisible() {
    return list.find(item => matches(item, filter))?.id;
  }

  async function refresh(preferred, nextFilter) {
    if (!reviewer) return;
    feedback(message, "正在读取审核队列…");
    try {
      list = await request(api + "packages");
      feedback(message);
      const requested = list.find(item => item.id === preferred);
      if (nextFilter) filter = nextFilter;
      else if (requested && !matches(requested, filter)) {
        if (requested.stage === "awaiting_agent") filter = "agent";
        else if (requested.status === "pending") filter = "human";
        else filter = requested.status === "approved" ? "porting" : "handled";
      }
      renderFilters();
      await pick(/^[a-f0-9]{32}$/.test(preferred ?? "") ? preferred : firstVisible());
    } catch (error) {
      feedback(message, error.message, true);
    }
  }
  document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
    filter = button.dataset.filter;
    renderFilters();
    pick(firstVisible());
  }));
  byId("refresh").addEventListener("click", () => refresh(selected));
  account.then(identity => {
    reviewer = identity;
    refresh(new URLSearchParams(location.search).get("package"));
  });
  setupMcpDialog();
}

function setupMcpDialog() {
  const dialog = byId("mcp-dialog");
  const config = byId("mcp-config");
  const copyButton = byId("copy-mcp");
  const message = byId("mcp-feedback");
  byId("open-mcp").addEventListener("click", async () => {
    dialog.showModal();
    copyButton.disabled = config.hidden = true;
    feedback(message, "正在读取本机配置…");
    try {
      const result = await request(api + "mcp-config");
      config.textContent = JSON.stringify(result, null, 2);
      copyButton.disabled = config.hidden = false;
      feedback(message);
    } catch (error) {
      feedback(message, error.message, true);
    }
  });
  copyButton.addEventListener("click", () => copy(config.textContent, message, "MCP 配置已复制"));
}

const page = document.body.dataset.page;
if (page === "login") setupLogin();
else {
  const account = setupSession();
  if (page === "submit") {
    setupGuide();
    setupUpload();
    setupTutorial();
  } else if (page === "account") setupAccount();
  else setupReview(account);
}
