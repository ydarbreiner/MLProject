# Classification Color Overrides Plan

## 1) Current Behavior
- **Default classification rendering**: Uses Giro3D’s classification ColorMap when the active attribute is `Classification` (default ASPRS colors). Lasso edits work because they overwrite the `Classification` buffer for selected points and the existing map recolors them automatically.
- **Palette persistence**: Display preferences and `setClassificationColors` store custom colors but binding into Giro3D’s rendering has been inconsistent.
- **Mode switching**: `setColorScheme` sets the active attribute per mode (RGB/Color, Elevation/Z, Classification/Classification, Cluster/UserData) and triggers map setup per mode.

## 2) Attempts That Failed
- **Per-vertex repaint + switch to `Color`**: Painted vertex colors based on the palette and set active attribute to `Color`. Result: missing tiles and unstable rendering; diverged from Giro3D’s expected classification path.
- **Repeated attribute flipping / palette versioning**: Tried to force updates per tile and per palette change; led to glitches and disappearing chunks.
- **Mixed ColorMap + vertex repaint**: ColorMap rebuilds plus vertex painting caused conflicts and did not reliably change colors.

## 3) Root Cause
- Custom palette updates were not consistently consumed by Giro3D. Switching to the `Color` attribute bypassed the classification pipeline and caused instability. The renderer needs a properly bound classification ColorMap while keeping the `Classification` attribute active for all nodes/tiles.

## 4) Proposed Best-Case Approach
Keep classification rendering on the `Classification` attribute and inject a custom ColorMap (LUT) for overrides.
- Build a 256-entry LUT from the custom palette (fallback to neutral color for missing entries).
- Create/assign a new ColorMap with `min=0`, `max=255`, `mode=Discrete` (or equivalent).
- Bind the ColorMap to the `Classification` attribute (`colorMap.attribute = 'Classification'`, `colorMap.active = true`, `colorMap.needsUpdate = true`).
- Assign it to `pointCloudEntity.colorMap` and, if the material exposes `colorMap`, set it and `material.needsUpdate = true` (ensure `vertexColors` is false in classification mode so the map is used).
- Reapply `activeAttribute = 'Classification'` and force `notifyChange`/`render`.
- Reapply the ColorMap after new tiles load (hook tile load or reuse the existing override processing loop) so late-loaded nodes pick up the palette.

**Safeguards for other modes (RGB/Elevation/Cluster)**
- RGB: `activeAttribute = 'Color'`, clear/disable `colorMap` on the material, and enable `vertexColors`.
- Elevation: `activeAttribute = 'Z'`, build/assign the elevation ColorMap, bind it to the material, and disable `vertexColors`.
- Cluster: same pattern as elevation but with the cluster LUT.
- Avoid any attribute switching to `Color` inside classification mode; keep classification self-contained.

Why this should work:
- Stays within Giro3D’s intended classification path (ColorMap + `Classification` attribute), avoiding per-vertex hacks.
- Ensures the map is explicitly bound to the correct attribute and material.
- Handles late-loaded tiles by reapplying the map after tiles appear.

## 5) Implementation Steps (code-level)
- In `frustum-culled-copc.service.ts`:
  - `setColorScheme('classification')`: set `activeAttribute = 'Classification'` (and lowercase if needed); call `configureClassificationColors()`; if a custom palette exists, call `applyClassificationColorLUT()`.
  - `setClassificationColors()`: rebuild the custom palette → call `applyClassificationColorLUT()` → set `activeAttribute = 'Classification'`.
  - `applyClassificationColorLUT()`: build the LUT; create a new ColorMap (`colors`, `min=0`, `max=255`, `mode=Discrete`); set `colorMap.attribute = 'Classification'`, `active = true`, `needsUpdate = true`; assign to `pointCloudEntity.colorMap`; if material has `colorMap`, set it and `needsUpdate = true`; reapply `activeAttribute = 'Classification'`; call `notifyChange` and `render`.
  - `processClassificationOverrides()`: only apply pending overrides; additionally reapply the ColorMap after tile load events so new nodes get the palette.
- Remove per-vertex repaint logic and attribute flipping in classification mode.

## 6) Verification Checklist
- Rebuild frontend.
- Switch between RGB/Elevation/Classification/Cluster; modes appear and render correctly.
- In Classification mode, change Ground to red, Apply → colors update without missing tiles.
- Load a dataset or force new tiles to load → classification colors persist on new nodes.

## 7) If Colors Still Don’t Change
- Explicitly enforce the Points material to honor `colorMap` for the `Classification` attribute (some Giro3D builds require a material flag or shader hook).
- Devtools spot check:
  - `pointCloudEntity.colorMap.colors[classId]` matches the override.
  - `pointCloudEntity.getActiveAttribute()` is `Classification` in classification mode.
  - A points node’s material has `colorMap` set and `vertexColors` disabled when using the map.

## 8) Cleanup/Reset for Stability
- Remove per-vertex classification repaint code and any switches to `Color` in classification mode.
- Ensure palette changes do not flip active attributes away from `Classification`.
- Reapply the classification ColorMap after mode switches and after tiles load.
