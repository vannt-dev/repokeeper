import {
  buildConfig,
  fileCommands,
  MODULES,
  matchingPreset,
  NEEDS_VERSION,
  PLACEHOLDERS,
  PLATFORM_STACKS,
  PRESETS,
  presetInput,
  problems,
  renderConfig,
  STACKS,
  shortcutCommand,
} from "./config.js";

const form = document.getElementById("form");
const byId = (id) => document.getElementById(id);

function element(tag, properties = {}, children = []) {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
}

function buildLists() {
  byId("stacks").append(
    ...STACKS.map((stack) =>
      element("div", { className: "stack" }, [
        element("label", {}, [element("input", { type: "checkbox", name: "stack", value: stack.id }), stack.label]),
        element("input", {
          type: "text",
          name: `folder-${stack.id}`,
          placeholder: "at the root",
          ariaLabel: `Folder of ${stack.label}`,
          hidden: true,
        }),
      ]),
    ),
  );
  byId("presets").append(
    ...PRESETS.map((preset) =>
      element("label", { className: "preset" }, [
        element("input", { type: "radio", name: "preset", value: preset.id }),
        element("span", {}, [
          element("strong", { textContent: preset.id }),
          element("small", { textContent: preset.summary }),
        ]),
      ]),
    ),
  );
  byId("modules").append(
    ...MODULES.map((module) =>
      element("label", { className: "module" }, [
        element("input", { type: "checkbox", name: "module", value: module.id }),
        element("span", {}, [module.label, element("small", { textContent: module.hint })]),
      ]),
    ),
  );
  form.elements.copyright.placeholder = PLACEHOLDERS.copyright;
  form.elements.contact.placeholder = PLACEHOLDERS.contact;
  form.elements.codeowners.placeholder = `${PLACEHOLDERS.codeowners}, @your-org/team`;
  byId("needs").textContent = NEEDS_VERSION;
}

const boxes = (name) => [...form.querySelectorAll(`input[name="${name}"]`)];

function readForm() {
  const fields = form.elements;
  return {
    platform: fields.platform.value,
    stacks: boxes("stack")
      .filter((box) => box.checked)
      .map((box) => ({ id: box.value, directory: fields[`folder-${box.value}`].value })),
    modules: Object.fromEntries(boxes("module").map((box) => [box.value, box.checked])),
    health: {
      license: fields.license.value === "mit",
      copyright: fields.copyright.value,
      contact: fields.contact.value,
      codeowners: fields.codeowners.value,
    },
    defaultBranch: fields.defaultBranch.value,
    workflows: { mode: fields.workflowMode.value, ref: fields.workflowRef.value, source: fields.workflowSource.value },
    protect: { enabled: fields.protect.checked, approvals: fields.approvals.value },
    security: fields.security.checked,
  };
}

/** Sets the switches a preset decides; the stacks and the typed details stay as they are. */
function applyPreset(id) {
  const preset = presetInput(id, form.elements.platform.value);
  for (const box of boxes("module")) box.checked = preset.modules[box.value];
  form.elements.protect.checked = preset.protect.enabled;
  form.elements.approvals.value = preset.protect.approvals;
  form.elements.security.checked = preset.security;
}

function render() {
  const input = readForm();
  const github = input.platform === "github";

  for (const box of boxes("stack")) {
    const supported = PLATFORM_STACKS[input.platform].includes(box.value);
    box.disabled = !supported;
    if (!supported) box.checked = false;
    box.closest(".stack").classList.toggle("off", !supported);
    form.elements[`folder-${box.value}`].hidden = !(box.checked && github);
  }
  byId("platform-note").hidden = github;
  byId("github").hidden = !github;
  byId("health").hidden = !input.modules.health;
  byId("workflow-source").hidden = input.workflows.mode !== "mirror";
  byId("workflow-ref").hidden = !["ref", "mirror"].includes(input.workflows.mode);
  byId("workflow-ref-label").textContent =
    input.workflows.mode === "mirror" ? "Tag, branch or commit SHA (main when empty)" : "Tag or commit SHA";
  byId("approvals").hidden = !input.protect.enabled;

  // which preset the switches amount to, whatever else the form says
  const switches = { ...readForm(), workflows: { mode: "default", ref: "", source: "" } };
  switches.health = { ...switches.health, license: true };
  const preset = matchingPreset(switches);
  for (const radio of boxes("preset")) radio.checked = radio.value === preset;
  byId("custom-note").hidden = preset !== null;

  const current = readForm();
  const shortcut = shortcutCommand(current);
  byId("shortcut").hidden = shortcut === null;
  byId("shortcut-command").textContent = shortcut ?? "";
  byId("file-title").textContent = shortcut === null ? "Save the file" : "Or save the file";

  const found = problems(current);
  byId("problems").hidden = found.length === 0;
  byId("problems").replaceChildren(...found.map((text) => element("li", { textContent: text })));
  byId("file").textContent = renderConfig(buildConfig(current));
  byId("file-commands").textContent = fileCommands(current).join("\n");
}

form.addEventListener("input", (event) => {
  if (event.target.name === "preset") applyPreset(event.target.value);
  // a preset is a choice per platform: strict protects the branch on GitHub only
  if (event.target.name === "platform") {
    const preset = boxes("preset").find((radio) => radio.checked);
    if (preset) applyPreset(preset.value);
  }
  render();
});
form.addEventListener("submit", (event) => event.preventDefault());

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.copy) {
    await navigator.clipboard.writeText(byId(button.dataset.copy).textContent);
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = label;
    }, 1200);
  }
  if (button.id === "download") {
    const url = URL.createObjectURL(new Blob([byId("file").textContent], { type: "text/yaml" }));
    element("a", { href: url, download: ".repokeeper.yml" }).click();
    URL.revokeObjectURL(url);
  }
});

buildLists();
form.querySelector('input[name="stack"][value="node"]').checked = true;
applyPreset("standard");
render();
