const storageKey = "nnol.workshop.tutorial.seen.v1";
const byId = id => document.getElementById(id);

const steps = [
  {
    title: "制作你的第一份投稿",
    description: "跟着教程在页面上试搜地点、查看 Agent Prompt，再选用示例包了解提交和查询流程。"
  },
  {
    target: "locate",
    title: "选定地图地点",
    description: "搜索地标或直接在地图上选点。确定建筑锚点和街景观察点后，点击「复制地点资料」。",
    actionLabel: "试搜「十四中」",
    action() {
      const search = byId("place-search");
      search.value = "十四中";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      search.focus({ preventScroll: true });
    }
  },
  {
    target: "prepare-model",
    title: "把资料交给 Agent",
    description: "复制 Agent Prompt，和地点资料、实景照片或现有模型一起发给 Agent，让它按要求制作交付 ZIP。",
    actionLabel: "展开 Agent Prompt",
    action() {
      if (byId("prompt").hidden) byId("view-prompt").click();
    }
  },
  {
    target: "submit-package",
    side: "left",
    title: "校验并提交 ZIP",
    description: "拖入自己的 ZIP，或先选用十四中示例包。需要提交时，再点击「校验并提交」。",
    actionLabel: "选用示例包",
    action() {
      byId("use-example").click();
    }
  },
  {
    target: "status-lookup",
    side: "left",
    title: "用工单编号查进度",
    description: "校验通过后，复制回执里的工单编号。以后可用它查询最新一版的进度和开发者的意见。",
    actionLabel: "打开状态查询",
    action() {
      byId("status-lookup").open = true;
      byId("receipt").focus({ preventScroll: true });
    }
  }
];

export function setupTutorial() {
  const panel = byId("workshop-tour");
  const launcher = byId("open-tutorial");
  const next = byId("tour-next");
  const back = byId("tour-back");
  const action = byId("tour-action");
  const progress = byId("tour-progress");
  let current = 0;
  let highlight;

  function reveal() {
    if (!highlight) return;
    const narrow = window.matchMedia("(max-width: 620px)").matches;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    highlight.scrollIntoView({ block: narrow ? "start" : "center", behavior: reducedMotion ? "instant" : "smooth" });
  }

  function render(shouldScroll) {
    const step = steps[current];
    highlight?.classList.remove("tour-highlight");
    highlight = step.target ? byId(step.target) : undefined;
    highlight?.classList.add("tour-highlight");
    panel.dataset.side = step.side ?? "right";
    byId("tour-count").textContent = `第 ${current + 1} 步 / 共 ${steps.length} 步`;
    byId("tour-title").textContent = step.title;
    byId("tour-description").textContent = step.description;
    progress.setAttribute("aria-valuenow", String(current + 1));
    byId("tour-progress-bar").style.width = `${(current + 1) * 100 / steps.length}%`;
    action.hidden = !step.action;
    action.textContent = step.actionLabel ?? "";
    back.hidden = current === 0;
    next.textContent = current === 0 ? "开始教程" : current === steps.length - 1 ? "完成教程" : "下一步";
    if (shouldScroll) reveal();
  }

  function open() {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // The tutorial remains usable when the browser blocks local storage.
    }
    current = 0;
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    render(false);
    next.focus({ preventScroll: true });
  }

  function close() {
    const restoreFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    highlight?.classList.remove("tour-highlight");
    highlight = undefined;
    if (restoreFocus) launcher.focus({ preventScroll: true });
  }

  launcher.setAttribute("aria-expanded", "false");
  progress.setAttribute("aria-valuemax", String(steps.length));
  launcher.addEventListener("click", open);
  byId("tour-close").addEventListener("click", close);
  next.addEventListener("click", () => {
    if (current === steps.length - 1) close();
    else {
      current++;
      render(true);
    }
  });
  back.addEventListener("click", () => {
    current--;
    render(true);
    if (current === 0) next.focus({ preventScroll: true });
  });
  action.addEventListener("click", () => {
    steps[current].action?.();
    reveal();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden && !event.defaultPrevented && !byId("map-picker").open) {
      event.preventDefault();
      close();
    }
  });

  const url = new URL(location.href);
  if (url.searchParams.get("tutorial") === "1") {
    url.searchParams.delete("tutorial");
    history.replaceState(history.state, "", url);
    open();
  } else {
    let seen = false;
    try {
      seen = localStorage.getItem(storageKey) === "1";
    } catch {
      // This visit can still show the initial tutorial.
    }
    if (!seen) open();
  }
}
