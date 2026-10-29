/**
 * DLL 生成脚本：模板加载 + 变量替换
 *
 * 模板为独立文件，直接改这两个文件即可更新脚本（无需改 TS 代码）：
 * - `../templates/tfs-dll.bat`  TFS 版（tf get ./* /recursive）
 * - `../templates/git-dll.bat`  Git 版（git pull）
 *
 * 模板中 4 个可配置变量：
 * - `{{PROJECT_PATH}}`       → 代码根目录（projectPath）
 * - `{{PROJECT_SOLUTION}}`   → 解决方案文件（projectSolution）
 * - `set "buildConfiguration=..."` → 生成模式（Debug / Release）
 * - `set "buildPlatform=..."`      → 平台（Any CPU / x86 / x64）
 *
 * 容错：若模板被整份替换为不带 `{{...}}` 标记的原始脚本，仍会按 `set <变量>=` 行覆盖
 * 上述 4 个变量的值（保持模板原有的引号风格），因此直接丢一份新脚本进 templates 也能用。
 */
import tfsDllScriptTemplate from "../templates/tfs-dll.bat?raw";
import gitDllScriptTemplate from "../templates/git-dll.bat?raw";

export type DllScriptType = "TFS" | "Git";

export type DllScriptForm = {
    type: DllScriptType;
    projectPath: string;
    projectSolution: string;
    buildConfiguration: string; // Debug / Release
    buildPlatform: string; // Any CPU / x86 / x64
};

// 脚本类型 → 模板原文（新增类型时在此登记，并在 ../templates 放一个同名 .bat）
const DLL_SCRIPT_TEMPLATES: Record<DllScriptType, string> = {
    TFS: tfsDllScriptTemplate,
    Git: gitDllScriptTemplate,
};

/** 取模板原文（含 {{PROJECT_PATH}} / {{PROJECT_SOLUTION}} 占位标记） */
export const getDllScriptTemplate = (type: DllScriptType): string =>
    DLL_SCRIPT_TEMPLATES[type] ?? DLL_SCRIPT_TEMPLATES.TFS;

/** 代码根目录统一为 Windows 反斜杠并去掉尾部分隔符（避免 `"D:\x\"` 变成转义引号） */
const normalizeProjectPath = (projectPath: string): string =>
    String(projectPath || "").trim().replace(/\//g, "\\").replace(/\\+$/, "");

/**
 * 覆盖单行 `set <变量>=值`，保持模板原有引号风格
 * （`set p="v"` → 值带引号；`set "p=v"` → 变量名带引号、值不带引号）
 */
const rewriteSetLine = (line: string, name: string, value: string): string => {
    if (!new RegExp(`^\\s*set\\s+"?${name}=`, "i").test(line)) return line;
    const nameQuoted = /^\s*set\s+"/i.test(line);
    // 取等号后的部分作为原值
    let rest = line.replace(/^\s*set\s+"?/i, "");
    rest = rest.slice(rest.indexOf("=") + 1);
    // 变量名带引号的写法：结尾那个 " 属于 set 语法，先去掉再判断值本身是否带引号
    if (nameQuoted && rest.endsWith('"')) rest = rest.slice(0, -1);
    const valueQuoted = rest.startsWith('"') && rest.endsWith('"');
    const written = valueQuoted ? `"${value}"` : value;
    return nameQuoted ? `set "${name}=${written}"` : `set ${name}=${written}`;
};

/**
 * 按用户输入渲染 DLL 生成脚本内容
 * @param form 表单（类型/代码根目录/解决方案文件/生成模式/平台）
 * @returns 完整脚本字符串（CRLF 换行，适配 Windows bat）
 */
export const buildDllScriptContent = (form: DllScriptForm): string => {
    const projectPath = normalizeProjectPath(form.projectPath);
    const projectSolution = String(form.projectSolution || "").trim().replace(/\//g, "\\");

    // 1) 占位标记替换（函数形式，避免路径里的 $ 被当作替换模式）
    let content = getDllScriptTemplate(form.type)
        .replace(/\{\{PROJECT_PATH\}\}/g, () => projectPath)
        .replace(/\{\{PROJECT_SOLUTION\}\}/g, () => projectSolution);

    // 2) 兜底：按 set 行覆盖 4 个变量（模板无占位标记时同样生效）
    const variables: [string, string][] = [
        ["projectPath", projectPath],
        ["projectSolution", projectSolution],
        ["buildConfiguration", form.buildConfiguration],
        ["buildPlatform", form.buildPlatform],
    ];
    content = content
        .split(/\r?\n/)
        .map((line) => variables.reduce((acc, [name, value]) => rewriteSetLine(acc, name, value), line))
        .join("\n");

    // bat 惯例 CRLF：先把可能混入的 \r\n 归一为 \n，再统一替换为 \r\n
    return content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") + "\r\n";
};

/** 保存对话框默认文件名（沿用原脚本命名风格，[xx] 由用户自行调整） */
export const buildDllScriptFileName = (form: DllScriptForm): string =>
    `${form.type}生成${form.buildConfiguration}环境dll.bat`;
