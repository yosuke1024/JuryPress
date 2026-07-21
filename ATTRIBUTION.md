# Attribution

JuryPress incorporates materials derived from Judgie-AI. These materials remain subject to the upstream Judgie-AI MIT License.

JuryPress also bundles the Noto font families, which are licensed separately under the SIL Open Font License 1.1.

## Derived Materials

The following assets and specifications are derived from the upstream project:

- **Jury Persona Definitions**: The simulated AI persona roles and system prompts (Alex, David, Lisa, Marcus, Sarah) used in evaluation runs.
- **Evaluation Rubric**: The weighted scoring categories and evaluation guidelines.
- **Judge Avatars**: Visual avatar images representing the five judges.

## Upstream Project Information

- **Upstream Repository**: [yosuke1024/judgie-ai](https://github.com/yosuke1024/judgie-ai)
- **Upstream Commit SHA**: The base design is derived from commit `56b27d42cf89a508b9816e0e648cb9ea81881b2a` (refer to `config/season.json` for specific versioning).
- **Upstream Copyright Notice**:
  ```text
  Copyright (c) 2026 PixApps / Yosuke Suzuki
  Licensed under the MIT License.
  ```

## Upstream MIT License Text

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Bundled Fonts

Social preview cards are rasterized from SVG, which requires the type to be available as font
files at build time rather than resolved from the reader's system. The following faces are
vendored under `assets/fonts/` for that purpose:

- `NotoSans-Regular.ttf`
- `NotoSans-Bold.ttf`
- `NotoSerif-Bold.ttf`

- **Project**: [Noto Fonts](https://github.com/googlefonts/noto-fonts)
- **License**: SIL Open Font License, Version 1.1 — see [assets/fonts/OFL.txt](./assets/fonts/OFL.txt)
- **Copyright Notice**:
  ```text
  Copyright 2018 The Noto Project Authors (github.com/googlei18n/noto-fonts)
  ```

These fonts are not covered by the JuryPress MIT License. See [LICENSING.md](./LICENSING.md).
