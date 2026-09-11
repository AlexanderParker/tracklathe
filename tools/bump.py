import io, json, re, sys

import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEW = int(sys.argv[1])

def rw(path, fn):
    s = io.open(path, encoding="utf-8").read()
    s2 = fn(s)
    io.open(path, "w", encoding="utf-8", newline="\n").write(s2)
    return s2

# --- app.js: a BUILD constant and the staleness check (added once)
def app(s):
    if "const BUILD =" not in s:
        s = s.replace(
            'const $ = (id) => document.getElementById(id);\n',
            'const $ = (id) => document.getElementById(id);\n'
            '\n'
            '// Must match version.json and the ?v= cache keys. GitHub Pages caches\n'
            '// every file for ten minutes, so a reload inside that window can pair a\n'
            '// fresh page with stale scripts, or the reverse -- and the result is a\n'
            '// page that half works, which is worse than one that says so.\n'
            'const BUILD = 0;\n', 1)
        s = s.replace(
            '  offerRestore();\n',
            '  offerRestore();\n'
            '  checkForNewerBuild();\n', 1)
        s = s.replace(
            '// ------------------------------------------------------------------ init\n',
            '// Ask the server, bypassing every cache, which build it is serving; if\n'
            '// that is not the one running, offer a reload. Failure is silence: this\n'
            '// is a courtesy, not a gate.\n'
            'async function checkForNewerBuild() {\n'
            '  try {\n'
            '    const res = await fetch("version.json", { cache: "no-store" });\n'
            '    if (!res.ok) return;\n'
            '    const { v } = await res.json();\n'
            '    if (!Number.isInteger(v) || v === BUILD) return;\n'
            '    const bar = document.createElement("div");\n'
            '    bar.className = "restore";\n'
            '    const text = document.createElement("span");\n'
            '    text.textContent = `A newer Tracklathe is available (build ${v}; this is ${BUILD}).`;\n'
            '    const btn = document.createElement("button");\n'
            '    btn.className = "btn-primary";\n'
            '    btn.textContent = "Reload";\n'
            '    btn.addEventListener("click", () => location.reload());\n'
            '    bar.append(text, btn);\n'
            '    document.body.insertBefore(bar, document.querySelector("main"));\n'
            '  } catch (e) { /* offline, or a file:// page */ }\n'
            '}\n'
            '\n'
            '// ------------------------------------------------------------------ init\n', 1)
    s = re.sub(r"const BUILD = \d+;", f"const BUILD = {NEW};", s)
    return s

rw(f"{ROOT}/src/app.js", app)

# --- every ?v= key, in the page and the module imports
for f in ["index.html", "src/app.js", "src/engine.js", "src/grid.js", "src/pad.js", "src/song.js", "src/store.js"]:
    rw(f"{ROOT}/{f}", lambda s: re.sub(r"\?v=\d+", f"?v={NEW}", s))

# --- the served version
io.open(f"{ROOT}/version.json", "w", encoding="utf-8", newline="\n").write(json.dumps({"v": NEW}) + "\n")
print("build", NEW)
