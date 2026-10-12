# Changelog

## 0.2.0 — 2026-10-12
- **Paint**: flat face, brush and whole-part modes, eraser, eyedropper (`Alt` + click). Paint is stored as steps (`paint`) so it survives recomputing, and Claude can paint the same way
- **Materials**: plastic, matte, glossy, metal (with a soft room reflection)
- **GLB export with a palette texture** (UVs point into a small colour image) so colours work with ordinary materials in Unity, Godot and three.js
- The brush selects triangles by distance, so large low-poly faces can be painted
- *Start empty* uses the panel's language for the new model's name

## 0.1.1 — 2026-10-12
- 3MF: own reader that follows separate object files (Production extension). Bambu Studio / PrusaSlicer project files now open

## 0.1.0 — 2026-10-12
- First version: open STL / 3MF / OBJ / GLB, orbit and views, printer bed and *fits the bed*, overhangs, section X / Y / Z, pins, measuring, undo
- Recipe computed with manifold (WebAssembly): primitives, booleans, transforms, `cut`, `lid`, `params` with sliders and expressions
- *Send to AI*: four views with pin numbers, sizes and section outlines for Claude; `MODEL_FORMAT.md` copied to the folder
- Export STL / 3MF / GLB without overwriting
