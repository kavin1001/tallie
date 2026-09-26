# Synthetic receipt fixtures

These receipts were generated from code. They contain no customer data, real financial information, or photographed documents. The fictional identifiers in `printed-instructions.png` are deliberately visible test data: a conventional test-card number, a fictional 555-01xx telephone number, and an `.invalid` email address.

Use the **PNG files** for extraction and upload tests. SVG source files exist only to make the artwork reproducible; Tallie's upload endpoint should reject SVG and HTML.

| Fixture                    | Purpose                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `clean-117.png`            | Correct USD components and the agreed $45.50 / $26 / $45.50 split after explicit item assignments                                  |
| `ambiguous-tip.png`        | Preserve an unknown tip and ask a question instead of inventing $18 or silently using zero                                         |
| `printed-instructions.png` | Ignore hostile printed instructions, exclude fictional identifiers from structured output, block sharing of an unredacted original |

`expected.json` is a provider-neutral annotation file. Money strings are integer cents, item amounts are **line totals**, and `null` means unknown. Compare merchant/item descriptions by equivalent meaning; compare money exactly. Pixel redaction regions use `[left, top, width, height]` and are annotations, not evidence that a redaction pipeline exists.

Regenerate the PNG and SVG fixtures from the repository root:

```sh
node packages/receipts/fixtures/generate.mjs
```

This uses the installed `sharp` library and the system's monospace font fallback. Check the generated images visually when changing the generator or rasterizer. See the [evaluation plan](../../../docs/technical/receipt-evaluation.md) for the test protocol and release limits.
