# CyImagePro 客户端（GPT_Image_2_Application）

## CyImagePro UI Development

Any task that creates or modifies user-facing UI MUST read:

`.claude/skills/cyimagepro-ui/SKILL.md`

before implementation, then the relevant layer docs (tokens / components / layouts / patterns / copy / model-selector) as needed.

Rules:

- Reuse existing CyImagePro design tokens (`var(--*)` from `src/App.css`), primitives (`.app-btn-*`, `.form-group`) and page patterns. Do not invent new colors, spacing, radius, typography or Chinese UI terminology inside business components unless the design system (skill files) is explicitly updated.
- Model list display goes through `src/features/aiProviders/modelUiPolicy.ts`; billing labels go through `getBillingLabel` + `BillingBadge`. Never guess model capabilities from model names, never hand-write billing copy.
- Dependency direction: Token → Primitive Component → Business Component → Page. Never the reverse.
- After UI modification, perform the CyImagePro UI Compliance Check in `.claude/skills/cyimagepro-ui/examples.md`, then run `npm run typecheck && npm test && npm run build`.

Do not copy the CY Video Studio cyan theme into this project; CyImagePro keeps its own dark workspace + Indigo/Violet identity.
