<sub><b>Web</b> profile plugin — host half + browser half.</sub>

> **English**: [README.md](README.md) | **中文**: [README.zh.md](README.zh.md)

---

# DSH Hardware Sandbox

**A 3D hardware sandbox for DSH: build the assembly, wire it up, and run your project's own code against virtual hardware.**

<!-- 收录徽章位：awesome-dsh-plugin / DSH 社区列表 / dsh.so / dsh-plugin.org / …（收录通过后逐个补上官方徽章；徽章图片本身不自制） -->

**Install (from GitHub; this package is not published on npm)**

```sh
dsh plugin --profile web add github:Noob-stupid/dsh-breadboard
```

Then reload the page. The sandbox registers into the **`main`** slot (the 3D view) and the
**`sidebar.panellist`** slot (the panels); `skill/SKILL.md` ships with the plugin, so an agent
that has it installed already knows how to drive it.

**Like it?** [Give it a star on GitHub](https://github.com/Noob-stupid/dsh-breadboard) — the
panel has the same hook in its bottom-right corner.

Three things make that one line work — all three are in this repository:

| Requirement | Where | Note |
|---|---|---|
| repo topic `dsh-plugin` | GitHub repository topics | makes the repo discoverable in community lists |
| a `dsh.bundle` manifest | `package.json` → `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` | **without it `dsh plugin add` installs nothing** — and the UI symptom is misleading: the plugin list says "no composition bundle declared", while what actually broke is the assembly, so every `/api/*` returns 404 and the panel simply never appears |
| an exported `apply(ctx)` | `src/index.ts` (host) / `src/client/index.ts` (browser) | host half registers routes, tools and the simulation engine; browser half registers the two slots above |

## What it is / what it solves

Normally the parts of a hardware project you can only *try on the real board* are the wiring
itself, the sensor semantics at register level, and the failure handling. This plugin moves those
into a virtual scene that actually runs:

- **3D assembly** — drop parts from the built-in model library (ESP32, Raspberry Pi 4B, BME280,
  HC-SR501 PIR, LED module, MPL3115A2, breadboard), wire them port by port, and get a live
  SSOT (single source of truth) assembly state with topology and electrical checks.
- **Project-level hardware-in-the-loop** — a **real Python process** runs **your project's code**.
  A Python shim intercepts its `smbus`/I2C access and answers from virtual devices, so the project
  under test reads register-level values (e.g. it performs the real BME280 compensation math on
  data coming from the virtual chip).
- **Networked-device emulation** (a second, separate class of virtual hardware) — a device that
  actively POSTs to **your** external HTTP backend on a real cadence: register → pull config →
  periodic report. Verified end-to-end against a real seat-selection system
  (device → HTTP → backend state machine → database).
- **Failure injection** — unplug a wire, return NACK, force a reading, take a device offline, and
  watch whether the project's error handling actually catches it.
- **Project-level convenience** — scan a real project folder to learn which hardware it needs, and
  switch the entire hardware setup in one click.

Requires DSH with the **`web`** profile and `webServer`, `tools` and `subprocess` services. The
host half declares them as **hard `inject` dependencies on purpose**: if any of them is missing the
plugin does not activate at all, rather than activating with tools silently unregistered, a blank
panel, or a simulation engine that cannot spawn.

### See it without a real project

`examples/zhizuo-virtual-esp32/` is a standalone script version of the virtual ESP32 seat sensor.
`hw_list_projects` lists the built-in demo project (**zhizuo-seat-node**) together with whether it
is currently wired end to end; `hw_import_project` puts its parts, wires and network binding in
place in one call.

## UI tour

The interface is currently **Chinese only** — the labels below are the literal ones on screen.

| Panel | What it does |
|---|---|
| **③ Project (one-click hardware swap)** | the main workflow. Per project body: file count (`N files (M skipped while sampling)` when sampling skipped files), **Scan requirements**, **Delete**; plus **+ Import project body (pick folder)** and **+ Import model bundle (pick folder)** |
| **① Add component** | click a model key to drop it into the scene (collapsed by default) |
| **② Re-skin models** | search for a model / import a file, and re-skin one of the model keys above; a model key with no geometry renders as a placeholder box (collapsed by default) |
| **Statistics** | render statistics (draw calls / triangles / FPS) — pure read, off by default |
| **Center 3D view** | placed components with world transforms, **blue cables** between ports, spatial warning boxes drawn on the components that have `warn`/`error` warnings, gizmo/right-click menu (pin, delete), port tooltips |
| **Panel overlay input box** | send a message to the current session without leaving the panel; if the host exposes no `agents` service the box is hidden (`capabilities.chat` is absent) |

Two of those deserve emphasis:

- **Scan requirements is a UI button only.** It is not exposed as an agent tool — the agent side has
  no equivalent. What the agent *can* do is everything after that: place parts, wire them, build a
  project blueprint, run simulations.
- **Deleting a project only deletes the project definition** (that one JSON). It does **not** touch
  the scene, so removing a project never wipes the hardware you have on screen.

## Quick start: three steps

1. **Import the project body** — *+ Import project body (pick folder)*, point it at a **complete
   project folder** (frontend + backend + hardware code). It is imported **without** models; the
   host reads it to work out which hardware it needs.
2. **Scan what hardware it needs** — the **Scan requirements** button in the ③ panel (UI only, see
   above). The report lists each candidate model key with the **evidence** — which files it was seen
   in — so you can judge it yourself; when the scan had to sample, it says so instead of implying it
   read everything.
3. **Import a model bundle** — *+ Import model bundle (pick folder)*, a folder laid out as
   `<modelKey>/model.glb`. Whatever you skip keeps rendering as a placeholder box.

Or skip steps 1–3 entirely: describe the system to the agent and let it call **`hw_save_project`**
to write a blueprint, then **`hw_import_project`** to place every part, wire and network binding in
one go.

## Agent tools: 13 `hw_*` tools

This is the actual registered list (nothing added, nothing omitted). The **when to use** column is
the point of the table: these tools are not interchangeable.

### Projects

| Tool | What it does | When to use it |
|---|---|---|
| `hw_list_projects` | list built-in hardware projects: parts, wires, network config, and whether each is currently wired end to end | **before** hand-placing anything — a blueprint is one call, hand-assembly is four steps and a missed step fails silently |
| `hw_import_project` | import a project: **clears the current assembly first**, then places parts, wires and network bindings | switching the whole hardware set; note it *replaces*, it does not add |
| `hw_save_project` | create or overwrite a project blueprint (stored under `$DSH_HOME/dsh-hardware-sandbox/projects/`) | the user described a system in words — write it down as a blueprint, then import it |

### Assembly

| Tool | What it does | When to use it |
|---|---|---|
| `hw_get_assembly` | read the SSOT summary: revision, components, connections, warnings (with their `message`, not just the code), power summary, virtual devices | **before every edit** — you need the real port ids; port ids are pin identities (`E4`), not silkscreen names (`GPIO23`) |
| `hw_edit_assembly` | one tool over the contract's `ClientAction` union: place / move / rotate / connect / disconnect / remove / pin | any change to the scene. It takes an action object, so read the samples in the tool description first |

### Simulation

| Tool | What it does | When to use it |
|---|---|---|
| `hw_run_simulation` | run a real Python project on virtual hardware; `duration` is **virtual** seconds; returns project output plus virtual/wall elapsed time | the actual hardware-in-the-loop run. `accelerated` (default) finishes far faster than real time; `realtime` paces to the wall clock for observation |
| `hw_get_sim_log` | read the last (or in-progress) run's project output, with an optional `tail` | when `hw_run_simulation`'s output was truncated |
| `hw_inject_fault` | inject `disconnect` / `nack` / `busy` / `set_reading` / `clear` against a device id or a `model:address` target | verifying that the project's error handling really observes the fault (e.g. an `OSError` after a disconnect) instead of assuming it does |

### Networked devices

| Tool | What it does | When to use it |
|---|---|---|
| `hw_network_add` | add a networked device (protocol adapter + endpoint + self-reported device id). **It does not start** | wiring a device emulator into your backend for the first time |
| `hw_network_devices` | list devices: protocol, endpoint, online state, report/failure counts, current readings, server-pushed config | confirming the device is actually connected and actually reporting — an added-but-idle device looks "fine" otherwise |
| `hw_network_control` | `start` / `stop` / `disconnect` (offline fault) / `clear` | **only `start` makes requests go out** — intentional, so nothing has external side effects by default; `disconnect` tests whether the far side notices |
| `hw_network_set_reading` | set a **physical** reading (e.g. `{ ir_front: true, ir_back: true }`, `true` = occluded) | testing whether the protocol layer is right, independently of the hardware path. The protocol translates the reading into a level (`ir_active_high` etc.), so polarity mistakes stay on the protocol side where they belong |
| `hw_set_occlusion` | occlude / un-occlude a placed part and propagate the effect **along the real wires** to a networked device's readings | testing the *hardware* path: if the PIR is not wired, or wired to the wrong pin, **nothing happens** — exactly like the real board |

## Reason codes and what to do about them

Failed assembly operations come back with a reason code (the contract's `WarningCode`, 12 of them,
in `src/contracts/assembly.ts`).

**Read the code. Change that thing. Do not guess-and-retry.**

| Code | Meaning | What to do |
|---|---|---|
| `bad_params` | the action's parameters are unusable (e.g. a rotation angle of `NaN` / `Infinity`) | fix the numbers — the problem is the value, not the component id |
| `direction_conflict` | two current directions fight (output to output / two supplies tied together) | rearrange per current direction: at least one end must become an input |
| `protocol_mismatch` | the two ports carry different signal kinds | use a matching port pair; check which signal that pin actually supports |
| `port_occupied` | **a different** cable already owns that port | unplug the other cable (`disconnect` with its `cableId`), or use another pin |
| `voltage_mismatch` | port voltages are not compatible | connect voltage-compatible ports, or add level shifting |
| `power_exceeded` | the assembly's power demand exceeds its supply budget | add supply or reduce draw |
| `i2c_address_conflict` | two devices on the bus share an I2C address | change one device's address (SDO/AD0 pin) |
| `i2c_pullup_missing` | the I2C bus has no pull-ups | add pull-ups on SDA/SCL |
| `unconnected_port` | a port has no connection at all | connect it as needed — and check you did not forget the *other* wire of a pair |
| `unknown_hardware_model` | no such model key | check the key against `hw_get_assembly`'s existing components |
| `component_pinned` | the component is pinned; the move was **explicitly refused** | unpin it first (right-click menu, or `set_pinned: false`) |
| `already_connected` | **that very pair** of ports is already connected | do not go looking for a cable that does not exist; to re-route, disconnect this one first |

Two notes worth keeping:

- **`port_occupied` and `already_connected` are separate on purpose.** Merged into one code, the user
  goes hunting for a cable that does not exist.
- **Multiple *different* ports connecting to the same port is legal** (that is an I2C bus) and does
  **not** raise `already_connected`.
- **`ok: true` does not mean the effect happened.** Every write should be followed by reading the
  assembly again.

## Model bundle format

The folder you hand to *+ Import model bundle* (and the layout the exporter round-trips through) is:

```
<modelKey>/
  model.glb      the geometry
  meta.json      optional metadata
```

- **Only GLB / GLTF are loaded for rendering.** The importer's format detection is
  content-based (not extension-based) and accepts glb / gltf / stl / obj / ply / 3mf / dae / fbx /
  wrl, but **STEP / IGES is refused outright rather than silently stored** — three.js has no loader
  for it, so a stored STEP would never render.
- Internally each stored model is one directory `<modelKey>/{model.bin, meta.json}`, with
  `model.bin` holding the geometry bytes (`meta.json` records `format`, `nodes`, `bytes`,
  `generator`). Storing the bytes with a neutral name is deliberate: it keeps the layout free of
  extension ambiguity and keeps `meta` bound to its bytes. Exported bundles use the
  `<modelKey>/model.glb` form above, so export and import are the same layout.
- Shipped with the package (seeded into the user model directory at startup, **only keys that are
  missing** — a model you imported is never overwritten):

| modelKey | Origin | In the bundle | Why |
|---|---|---|---|
| `bme280` | self-produced | yes | register-level device model + demo assembly |
| `led-5v` | self-produced | yes | simplest possible output part |
| `hc-sr501` | self-produced | yes | the demo assembly uses 2 of them (PIR) |
| `esp32-seat-sensor` | self-produced | yes | the networked-device demo |
| `rpi-4b` | imported from step.parts (third party) | **no** | third-party geometry — **not redistributed by this plugin**; import it yourself from the UI when you need it |
| `mpl3115a2` | imported from step.parts (third party) | **no** | same |
| `breadboard` | self-produced (no ports, passive) | no geometry | renders as the procedural placeholder box (sized from the contract) |

Why the split: the four self-produced models are ours to ship, so the plugin is **usable out of the
box** (the demo assembly is `esp32-seat-sensor` + 2 × `hc-sr501`, all shipped). The third-party
models are somebody else's assets with their own terms, so the plugin **does not redistribute
them** — the UI gives you search entry points and you import the file yourself. Port *semantics*
(I2C address, protocol, voltage, direction) are always produced here, because no model library
sells them — see `docs/05`.

## Wall-clock trap: why networked devices ignore virtual time

The virtual clock is **accelerating**: `advance(60)` burns 60 virtual seconds in tens of
milliseconds. A passive bus device is fine on it (deterministic, purely synchronous). A **networked
device is not** — it reports periodically on its own initiative, so a single fast-forward would fire
dozens of **real HTTP requests** at somebody's backend and hammer it.

So networked devices **always run on the wall clock, decoupled from virtual time**; their snapshot
carries `wallClockDriven: true`, and accelerated mode means nothing for them. Two consequences:

- **Accelerated mode does not apply to networked devices.** They keep reporting at their real
  interval regardless.
- **An added networked device sits in `idle` until you explicitly `start` it** — by default it
  produces no external side effects at all. One of the structural rules of this plugin: default
  behaviour must not reach outside the machine.

## Build and development

```powershell
# 1. install (also links the framework peers the build needs)
npm install

# 2. build: src/ -> lib/ (needs bash + a DSH source checkout)
$env:DSH_CHECKOUT='D:\dsh\deepseek-harness'; bash scripts/build.sh

# 3. tests and type checks (measured on 2026-10-11)
npm test                  # node --test, 308 tests, 0 failures
npm run typecheck         # tsc -p tsconfig.json --noEmit          -> exit 0
npm run typecheck:client  # tsc -p tsconfig.client.json --noEmit   -> exit 0
```

`scripts/build.sh` does three things beyond compiling: it links the build dependencies
(`scripts/link-deps.mjs`, also wired as `postinstall` because `npm install` wipes junctions it does
not recognize), it copies `project-shim/` into `lib/project-shim/`, and it writes
`lib/build-stamp.json`. That copy is **functional, not cosmetic** — `SimEngine` points the Python
process's `PYTHONPATH` at the shim (`smbus` + `RPi.GPIO` + `sitecustomize`), and since
`package.json`'s `files` only ships `lib`, a build without it publishes a package that cannot run.

`scripts/prepare.mjs` makes the **git install** work: `lib/` is gitignored, so a git install would
have no entry point. It builds only when `lib/index.js` is missing, and **a failed build only warns
(exit 0)** — a build failure usually means the machine lacks bash or devDependencies, and failing the
whole install would blame npm for it.

Release artifact: `npm pack` → a `.tgz` containing `lib`, `cordis.patch.yml`, `skill`, `docs`,
`models` and `scripts`.

### Self-check: is the live build the build you think it is?

```sh
curl http://127.0.0.1:<port>/@noob-stupid/dsh-breadboard/api/capabilities
```

All UI and API live under the route prefix `/@noob-stupid/dsh-breadboard/`. `GET …/api/capabilities`
returns `build` (the build timestamp of the **currently live** code) and `simTools` (the tools that
**actually registered**). Reach for it first when something looks wrong: tool registration failure is
**completely silent** — the model just says it does not have that capability and the UI shows nothing
unusual — and a hot reload can report success while the old module keeps serving.

## Known limitations

Honest list; none of these are hidden behind a default that pretends otherwise.

- **This package is not published on npm.** Install from GitHub. A prebuilt tarball exists as a
  release artifact, but there is no `npm install` line to offer.
- **The UI is Chinese only.** There is no locale switch in the panel today, and no English UI
  strings to promise.
- **Reading GPIO from the project's Python code is not implemented.** `hw_set_occlusion` propagates
  occlusion along the real wires into a networked device's readings, but the reverse direction —
  project code calling `RPi.GPIO.input()` through the shim — raises `NotImplementedError`, and the
  bridge's `gpio_read` / `gpio_write` are declared in the contract but not implemented
  ("protocol defined, behaviour model not implemented yet"). So a firmware that polls a pin and then
  reports cannot be exercised end to end yet; a firmware that reports over HTTP can.
- **Networked devices are not rendered in the 3D scene yet.** They are in the SSOT
  (`transport: 'network'`) and fully drivable by tools, but the front end does not draw them.
- **Only measured / verified paths are claimed.** The networked-device chain was verified against a
  real backend; an I2C-shaped *real* project has not been adapted yet — the I2C half is verified by
  this repository's own test projects.
- **Model size vs geometric fidelity is an open either/or** (documented in `docs/06` §6): scaling an
  imported model to the declared real-board `size` slightly deforms it. Today the plugin keeps real
  board dimensions and aligns ports to the deformed pitch.
- **`hw_set_occlusion` only reaches networked devices.** If the occluded part is wired to something
  that is not a networked device with a `pinMap`, nothing propagates — and the tool says so in its
  `reason` instead of silently succeeding.
- **The port count on some imported models is still converging** (e.g. a handful of Raspberry Pi
  header pins land on the PCB rather than on a pin mesh). Ports are usable; a few anchors are off by
  fractions of a millimetre.

## Documentation

| File | Contents |
|---|---|
| [docs/00-宿主API核实.md](docs/00-宿主API核实.md) | host API verification (slot tree, route registration, pitfalls) |
| [docs/01-项目定位.md](docs/01-项目定位.md) | project positioning, locked scope |
| [docs/02-步骤①-虚拟时钟内核.md](docs/02-步骤①-虚拟时钟内核.md) | the virtual clock kernel |
| [docs/03-模型库可行性验证.md](docs/03-模型库可行性验证.md) | model-library feasibility study (why not a scraper) |
| [docs/04-失败族-看起来正常实际全错.md](docs/04-失败族-看起来正常实际全错.md) | the "looks fine, actually all wrong" failure family (20 cases) |
| [docs/05-模型来源与导入方案.md](docs/05-模型来源与导入方案.md) | model sources and the import decision |
| [docs/06-状态与交接.md](docs/06-状态与交接.md) | status / handover sheet |
| [docs/07-联网设备-第二类虚拟硬件.md](docs/07-联网设备-第二类虚拟硬件.md) | networked devices, the second class of virtual hardware |

The docs are written in Chinese (they are working documents, and translating them would create two
copies to keep in sync). This README and `README.zh.md` are maintained as a matched pair.

## License

BSD-3-Clause.

---

dsh-breadboard
