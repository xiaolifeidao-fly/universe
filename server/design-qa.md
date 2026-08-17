# Delivery Task Session Design QA

**Source visual truth**

- User reference: `/var/folders/sh/f4sx61qs31g_zwvr_ffw68c00000gn/T/codex-clipboard-eec2b3ad-f22b-4e4e-be3a-bc2b88a9979d.png`
- Implementation capture: `/tmp/delivery-resizable-documents.png`
- Viewport: desktop `1280 x 720`; responsive behavior was retained for `390 x 844`.
- State: completed task `screen-p03`; document rail expanded after default collapsed state.

**Comparison evidence**

- Default state: document rail has `display: none`, the chat shell fills all usable space, and the document control exposes `aria-pressed=false`.
- Expanded state: clicking the file control opens the tabbed rail. It starts at `486px`; two keyboard resizes increase it to `534px`. The same separator is pointer-draggable in browsers, with a window-level pointer listener to keep resizing active after leaving the handle.

**Findings**

- No actionable P0, P1, or P2 issues found.
- The supplied screenshot depicts the open state. Default-collapsed behavior is intentional per the latest request.

**Required fidelity surfaces**

- Fonts and typography: existing manager typography and compact toolbar controls remain consistent with the supplied session layout.
- Spacing and layout rhythm: the collapsed state eliminates the unused grid track; the expanded rail maintains a readable minimum of `360px` and preserves at least `440px` for conversation.
- Colors and visual tokens: the separator, active document control, borders, and surfaces use existing manager tokens.
- Image quality and asset fidelity: no new visual assets are required; established Ant Design file and close icons identify the panel action.
- Copy and content: expand, collapse, and resize labels are localized in Chinese, English, and Indonesian.

**Patches made since previous QA**

- Added default-collapsed document rail, toolbar toggle, accessible separator, pointer dragging, and keyboard resize support.
- Added a no-layout-presence collapsed state and preserved phone behavior without a horizontal resize handle.

**Implementation checklist**

- [x] Full-screen task-session modal.
- [x] Default-collapsed document rail and click-to-expand control.
- [x] Horizontally resizable desktop document rail.
- [x] Requirement, design, and test document tabs.
- [x] Real requirement-document bridge loading and stored design/test result binding.
- [x] Desktop and phone layout verification.

final result: passed

# Codex Model And Reasoning Controls Design QA

**Source visual truth**

- Model reference: `/var/folders/sh/f4sx61qs31g_zwvr_ffw68c00000gn/T/codex-clipboard-ee0251d6-eb7b-475e-8108-9149814f901b.png`
- Reasoning reference: `/var/folders/sh/f4sx61qs31g_zwvr_ffw68c00000gn/T/codex-clipboard-feacd569-7164-43ee-b172-06752d34fc9f.png`
- Desktop implementation captures: `/tmp/codex-model-controls-model-menu.png` and `/tmp/codex-model-controls-reasoning-menu.png`
- Mobile implementation capture: `/tmp/codex-model-controls-mobile.png`
- Combined comparison evidence: `/tmp/codex-model-reasoning-comparison.png`
- Viewports: desktop `1280 x 720`; mobile `390 x 844`.
- State: AI preferences drawer open with the model menu and reasoning menu captured separately.

**Findings**

- No actionable P0, P1, or P2 issues found.
- The implementation intentionally uses the existing Ant Design drawer, select controls, green manager tokens, and compact console typography instead of copying the source application's standalone settings surface.
- The source's final two reasoning labels are visually duplicated. The implementation exposes the five distinct app-server values as `轻量 / 低 / 中 / 高 / 极高`, avoiding an ambiguous duplicate label.

**Required fidelity surfaces**

- Fonts and typography: control labels and menu options use the established manager UI scale and remain readable at desktop and mobile widths.
- Spacing and layout rhythm: model and reasoning controls align to the existing two-column preference rows; the mobile drawer collapses them to full-width stacked rows without overflow.
- Colors and visual tokens: selected options, focus rings, borders, surfaces, and drawer elevation use the existing manager green and neutral tokens.
- Image quality and asset fidelity: the references contain no product imagery or custom assets; existing Ant Design chevrons and selected-state treatment are appropriate.
- Copy and content: the model menu contains exactly `5.6 Sol`, `5.6 Terra`, and `5.6 Luna`; reasoning contains five distinct localized levels and defaults to `中`.

**Patches made since previous QA**

- Added a fixed three-model Codex catalog with `5.6 Terra` as the default.
- Added persisted reasoning effort with five supported app-server values.
- Added model and reasoning controls to global AI preferences and both delivery conversation composers.
- Propagated reasoning effort through single, serial, batch, planning, and follow-up execution paths.

**Implementation checklist**

- [x] Exactly three Codex model choices.
- [x] Five reasoning effort choices with a medium default.
- [x] Desktop dropdown states verified.
- [x] Mobile drawer layout verified at `390 x 844`.
- [x] Temporary unauthenticated preview hook removed after capture.

final result: passed

# Requirement Session Simplification Design QA

**Source visual truth**

- Annotated reference: `/var/folders/sh/f4sx61qs31g_zwvr_ffw68c00000gn/T/codex-clipboard-699528ea-0af5-40e6-879e-c9f87a4dff73.png`
- Implementation capture: `/tmp/delivery-requirement-session-simplified.png`
- Combined comparison evidence: `/tmp/delivery-requirement-session-comparison.png`
- Viewport: desktop `2048 x 1060`.
- State: existing requirement session with no conversation history; requirement form tab selected.

**Findings**

- No actionable P0, P1, or P2 issues found.
- The three annotated elements are absent: the `req-*` title suffix, the empty-session toolbar instruction, and the requirement summary card.
- The centered empty-state guidance remains intentionally available because it was not annotated for removal.

**Required fidelity surfaces**

- Fonts and typography: the existing compact manager title, toolbar, tab, form, and composer typography is unchanged.
- Spacing and layout rhythm: removing the summary card gives the transcript a clean empty state without shifting the history rail, right form, or composer.
- Colors and visual tokens: all remaining surfaces, borders, empty states, and controls continue to use existing manager tokens.
- Image quality and asset fidelity: no new imagery or replacement assets were introduced; established Ant Design icons remain intact.
- Copy and content: the annotated duplicate instruction is removed from the toolbar while the central empty-state instruction and all form labels remain unchanged.

**Patches made since previous QA**

- Removed the displayed requirement key from the modal title.
- Removed the empty-session toolbar instruction and the transcript requirement summary card.
- Removed the summary-only icon, data mapping, and CSS selectors; preserved all internal requirement-key behavior.
- Removed the temporary unauthenticated preview hook after capture.

**Implementation checklist**

- [x] Requirement identifier hidden from title.
- [x] Top empty-session instruction removed.
- [x] Requirement summary card removed.
- [x] Right-side requirement form and tab behavior retained.
- [x] Conversation history, empty state, model controls, composer, and actions retained.
- [x] Temporary visual-QA preview removed.

final result: passed

---

# Global And Scene AI Preferences Design QA

**Source visual truth**

- Claude model and Fast mode reference: `/var/folders/sh/f4sx61qs31g_zwvr_ffw68c00000gn/T/codex-clipboard-e7c8fe34-ec64-4f80-8560-bda73f37f665.png`
- Claude Effort reference: `/var/folders/sh/f4sx61qs31g_zwvr_ffw68c00000gn/T/codex-clipboard-87e1643d-f3f6-4b72-99f5-3cea98d5493e.png`
- Desktop global and inherited-scene capture: `/tmp/ai-preferences-claude-desktop.png`
- Desktop independent-scene override capture: `/tmp/ai-preferences-claude-scene-override.png`
- Mobile capture: `/tmp/ai-preferences-claude-mobile.png`
- Combined comparison evidence: `/tmp/ai-preferences-claude-comparison.png`
- Viewports: desktop `1440 x 900`; mobile `390 x 844`.

**Findings**

- No actionable P0, P1, or P2 issues found.
- Global Codex or Claude selection is the effective default for all four scenes until a scene explicitly overrides it.
- Inherited scene rows expose the effective provider and model; overridden scenes expand their own provider-specific model, Effort, and Fast mode controls.

**Required fidelity surfaces**

- Fonts and typography: existing compact manager typography is preserved; scene labels remain readable at desktop and mobile widths.
- Spacing and layout rhythm: global controls, scene selectors, and expanded overrides use the drawer's established row spacing and stack cleanly on mobile.
- Colors and visual tokens: segmented selection, Effort track, focus rings, switches, borders, and surfaces use existing manager green and neutral tokens.
- Image quality and asset fidelity: the implementation uses the established Ant Design controls; no product imagery or custom raster assets are required.
- Copy and content: Claude exposes exactly `Opus 5` and `Sonnet 5`, five Effort levels, and Fast mode. The four scenes are new requirement planning, requirement refinement, action execution, and product testing.

**Patches made since previous QA**

- Added persisted global provider selection with separate Codex and Claude defaults.
- Added optional per-scene provider, model, Effort, and Fast mode overrides with migration from the previous stored preference shape.
- Updated requirement and task composers to display and edit the effective scene configuration.
- Propagated effective configuration through planning, single execution, serial execution, batch execution, follow-up conversation, and testing paths.
- Added Claude CLI model, Effort, and Fast mode arguments and expanded bridge coverage.
- Removed the temporary unauthenticated preview hook after capture.

**Implementation checklist**

- [x] Global Codex or Claude preference.
- [x] Four scenes inherit global by default.
- [x] Each scene can independently override provider, model, and speed settings.
- [x] Composer controls display the effective provider and model.
- [x] Claude Opus 5, Sonnet 5, five Effort levels, and Fast mode.
- [x] Desktop and mobile visual verification.
- [x] TypeScript and 78 bridge tests passed.

final result: passed
