# 第三方组件许可声明

本文件列出随 **CRSM（学院行政办助理排班系统）** 分发到用户设备上的第三方组件，及其许可与版权信息。

CRSM 自身采用 **MIT 许可证**，全文见 [LICENSE](LICENSE)。

## 提取口径

- **范围**：`package.json` 的 `dependencies`，即会进入前端产物（`dist/`）并随桌面应用一并分发的运行时依赖。
  构建期工具（`devDependencies`）不随产物分发，见第二节。
- **版本**：取自 `package-lock.json` 实际锁定的版本，保证与本仓库可复现。
- **许可全文与 `NOTICE`**：**均为从各依赖包自带的 `LICENSE` / `NOTICE` 文件原样复制**，未作任何改写、删节或翻译。

## 一、随产物分发的组件

| 组件 | 版本 | 许可证 | 版权归属 |
|---|---|---|---|
| `@element-plus/icons-vue` | 2.3.2 | MIT | Copyright (c) 2020-PRESENT Element Plus |
| `@tauri-apps/api` | 2.11.1 | MIT（双许可择一） | 2019-2022, The Tauri Programme in the Commons Conservancy |
| `@tauri-apps/plugin-dialog` | 2.7.3 | MIT（双许可择一） | 2019-2022, The Tauri Programme in the Commons Conservancy |
| `@tauri-apps/plugin-fs` | 2.5.2 | MIT（双许可择一） | 2019-2022, The Tauri Programme in the Commons Conservancy |
| `@tauri-apps/plugin-opener` | 2.5.5 | MIT（双许可择一） | 2019-2022, The Tauri Programme in the Commons Conservancy |
| `dexie` | 4.4.6 | Apache-2.0 | Copyright (c) 2014-2017 David Fahlander |
| `element-plus` | 2.14.5 | MIT | Copyright (c) 2020-PRESENT Element Plus |
| `pinia` | 4.0.3 | MIT | Copyright (c) 2019-present Eduardo San Martin Morote |
| `vue` | 3.5.42 | MIT | Copyright (c) 2018-present, Yuxi (Evan You) |
| `vue-router` | 4.6.4 | MIT | Copyright (c) 2019-present Eduardo San Martin Morote |
| `xlsx-js-style` | 1.2.0 | Apache-2.0 | gitbrent（SheetJS Community Edition 的分支） |

两点需要说明：

1. **`@tauri-apps/*` 为双许可**（`MIT OR Apache-2.0`）。本项目按其中更简明的 **MIT** 条款使用——双许可允许使用方任选其一，此处作出并记录该选择。
2. **`xlsx-js-style` 是 SheetJS Community Edition 的分支**，沿用上游的 Apache-2.0 许可。本项目未修改其源码。

## 二、构建期依赖（不随产物分发）

`devDependencies` 中的工具仅在开发与构建阶段使用，不会被复制进 `dist/` 或安装包，因此不构成分发、不触发许可义务。其中包含一个值得记录的弱 copyleft 组件：

| 组件 | 许可证 | 说明 |
|---|---|---|
| `lightningcss` / `lightningcss-win32-x64-msvc` | MPL-2.0 | Vite 用于压缩 CSS。**仅在构建时执行，其代码不进入产物**，故 MPL-2.0 的文件级公开义务不被触发 |

本项目依赖树中**不含任何 GPL / LGPL / AGPL 组件**。

## 三、Dexie.js 的 NOTICE

Apache-2.0 许可证第 4(d) 条要求：若被许可作品包含 `NOTICE` 文件，则再分发时必须复现其中内容。`dexie` 提供了 `NOTICE`，内容如下（原样）：

```
Dexie.js

Copyright (c) 2014-2017 David Fahlander

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## 四、MIT 许可证全文

适用于：`@element-plus/icons-vue`, `@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-opener`, `element-plus`, `pinia`, `vue`, `vue-router`

各组件对应的版权归属见第一节表格。以下为 MIT 许可原文（自上游包原样复制；原文中的版权行属于该包自身，其许可条款文字与条款含义对上述各组件一致）：

```
The MIT License (MIT)

Copyright (c) 2018-present, Yuxi (Evan) You

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 五、Apache License 2.0 全文

适用于：`dexie`, `xlsx-js-style`

```
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright {yyyy} {name of copyright owner}

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## 维护说明

新增或升级运行时依赖后，本文件需同步更新：核对 `package.json` 的 `dependencies` 是否出现新的组件、许可类型是否变化，并检查该包是否新增了 `NOTICE` 文件。若引入了 copyleft 类组件，须先评估其与本项目 MIT 许可的兼容性再合并。
