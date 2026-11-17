import type { ChangedFile } from '../vcs/adapter.js'

export const BASE_STACKS = ['java', 'kotlin', 'python', 'typescript-node', 'frontend', 'csharp', 'vbnet', 'vbscript', 'go', 'rust',
  'shell', 'php', 'cpp', 'swift', 'terraform', 'ruby', 'dart', 'powershell'] as const
export const OVERLAY_STACKS = ['spring', 'angular', 'ionic', 'aspnet', 'blazor', 'maui', 'winforms', 'sqlserver',
  'laravel', 'rails', 'android'] as const
export type BaseStack = (typeof BASE_STACKS)[number]
export type OverlayStack = (typeof OVERLAY_STACKS)[number]

export interface StackSelection {
  bases: BaseStack[]
  overlays: OverlayStack[]
}

// A base is injected when it owns at least this share of the classified files
export const BASE_FLOOR = 0.2

// Config, docs and assets carry no language signal — excluded so they can't dilute or swing the vote
const NEUTRAL_EXTENSIONS = new Set([
  'json', 'yml', 'yaml', 'xml', 'md', 'txt', 'properties', 'toml', 'ini', 'lock', 'gradle', 'sql', 'csv', 'map', 'snap',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'woff', 'woff2', 'ttf', 'eot',
])
const FRONTEND_EXTENSIONS = new Set(['tsx', 'jsx', 'vue', 'svelte', 'html', 'htm', 'scss', 'css', 'sass', 'less'])
const JS_TS_EXTENSIONS = new Set(['ts', 'js', 'mjs', 'cjs'])

// .module/.pipe/.guard are deliberately absent: NestJS uses the same suffixes
const ANGULAR_PATH = /\.(component|directive)\.(ts|html|scss|css|sass|less)$|(^|\/)angular\.json$/
const IONIC_PATH = /(^|\/)(ionic\.config\.json|capacitor\.config\.[a-z]+)$/
const SPRING_PATH = /(^|\/)application(-[\w.-]+)?\.(properties|ya?ml)$/

// Every *_DIFF pattern takes [ \t]* after the diff marker: \s* would run across blank context lines and go quadratic
// Diff hunks often omit the import block, so a few unambiguous Spring annotations count too
const SPRING_DIFF = /^[+ ][ \t]*import\s+(static\s+)?org\.springframework\.|^[+ ][ \t]*@(SpringBootApplication|SpringBootTest|RestController|Autowired|ConfigurationProperties|(Get|Post|Put|Patch|Delete|Request)Mapping)\b/m
const ANGULAR_DIFF = /^[+ ][ \t]*import\b.*['"]@angular\//m
const IONIC_DIFF = /^[+ ][ \t]*import\b.*['"]@(ionic|capacitor)\//m
const FRONTEND_DIFF = /^[+ ][ \t]*import\b.*['"](react|react-dom|vue|svelte|@angular\/[^'"]*|@ionic\/[^'"]*)['"]/m

// .NET flavor — detect web / Blazor / MAUI / desktop-forms from imports, attributes, and XAML roots
// so a C# PR gets the right framework rules, not just generic .NET.
const ASPNET_PATH = /\.cshtml$/
const ASPNET_DIFF = /^[+ ][ \t]*using\s+Microsoft\.(AspNetCore|EntityFrameworkCore)\b|^[+ ][ \t]*\[(ApiController|Route|Http(Get|Post|Put|Patch|Delete))\b|^[+ ][ \t]*(WebApplication|WebApplicationBuilder)\b|^[+ ][ \t]*app\.Map(Get|Post|Put|Delete|Controllers)\b|:\s*Controller(Base)?\b/m
const BLAZOR_PATH = /\.razor$/
const BLAZOR_DIFF = /^[+ ][ \t]*using\s+Microsoft\.AspNetCore\.Components\b|^[+ ][ \t]*@rendermode\b/m
const MAUI_PATH = /(^|\/)MauiProgram\.cs$/
const MAUI_DIFF = /^[+ ][ \t]*using\s+Microsoft\.Maui\b|<(ContentPage|FlyoutPage|Shell)\b/m
const WINFORMS_PATH = /\.Designer\.cs$/
const WINFORMS_DIFF = /^[+ ][ \t]*using\s+System\.Windows\.Forms\b|^[+ ][ \t]*using\s+System\.Windows(\.(Controls|Media|Data|Shapes|Input))?\s*;|<(Window|UserControl)\b|:\s*Form\b/m

// VB markers are tested only on a vbnet base, so they cannot change a C#-only PR
const ASPNET_VB_PATH = /\.vbhtml$/
const ASPNET_VB_DIFF = /^[+ ][ \t]*Imports\s+Microsoft\.(AspNetCore|EntityFrameworkCore)\b|^[+ ][ \t]*<(ApiController|Route|Http(Get|Post|Put|Patch|Delete))\b|^[+ ][ \t]*Inherits\s+Controller(Base)?\b|^[+ ].*\bWebApplication\.CreateBuilder\b|^[+ ][ \t]*app\.Map(Get|Post|Put|Delete|Controllers)\b/m
// Every VB project has My Project/Resources|Settings|Application.Designer.vb; only form designers are WinForms
const WINFORMS_VB_PATH = /(^|\/)(?!(Resources|Settings|Application)\.Designer\.vb$)[^/]+\.Designer\.vb$/
const WINFORMS_VB_DIFF = /^[+ ][ \t]*Imports\s+System\.Windows\.Forms\b|^[+ ][ \t]*Imports\s+System\.Windows(\.(Controls|Media|Data|Shapes|Input))?[ \t]*$|<(Window|UserControl)\b|^[+ ][ \t]*Inherits\s+(System\.Windows\.Forms\.)?Form\b/m

// Marks a code-less migration PR (.sql + .csproj) as .NET; global.json only at the root, since i18n bundles reuse the name
const DOTNET_PROJECT_PATH = /\.(csproj|vbproj|sqlproj|sln|slnx)$|(^|\/)(Directory\.(Build|Packages)\.(props|targets)|packages\.config)$|^global\.json$/i

// Lexed so comments and escaped quotes cannot pose as SQL; .asp strings are skipped because HTML attribute quotes would read as strings
const CODE_LANG: Record<string, Lang> = { cs: 'c', csx: 'c', vb: 'vb', vbs: 'vbs', wsf: 'vbs', asa: 'vbs', asp: 'vbs' }
const VBSCRIPT_EXTENSIONS = new Set(['asp', 'asa', 'vbs', 'wsf'])
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rst', 'adoc'])
// Longer lines are minified or generated; skipping them keeps every scan linear
const MAX_SCAN_LINE = 2000
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|<!--|--|'|REM\b)/i
const SQL_SPECIAL = /--|\/\*|'/g
// The only code characters that can open a comment or a literal; the lexer jumps between them so long lines stay cheap
const LEX_SPECIAL: Record<Lang, RegExp> = { c: /\/[/*]|['"]/g, vb: /['"]|\brem\b/gi, vbs: /['"]|\brem\b/gi }
// Git quotes paths with special characters ("a/\303\251.cs"); the SQL scan needs every section boundary and extension
const SECTION_HEADER = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/gm

// SQL Server client APIs; the \b before Sql plus case keeps NpgsqlConnection, MySqlCommand, SqliteConnection, SQLiteConnection out
const SQLSERVER_CLIENT = /\b(Microsoft|System)\.Data\.SqlClient\b|\bMicrosoft\.(SqlServer\.|EntityFrameworkCore\.SqlServer\b)|\.Use(SqlServer|AzureSql)\s*\(|\bSql(Connection|Command|DataAdapter|DataReader|Parameter|BulkCopy|Transaction|Exception|DbType|ConnectionStringBuilder)\b|\.database\.windows\.net\b|"SqlServer:/
// These OLE DB providers and ODBC drivers only reach SQL Server, so they count without the other-database veto
const SQLSERVER_CONNSTR = /\b(SQLOLEDB|MSOLEDBSQL\d*|SQLNCLI\d*)\b|\bDriver\s*=\s*\{(SQL Server|SQL Native Client|ODBC Driver \d+ for SQL Server)/i
// SQL Server-only syntax (TOP and dbo. are shared with Access); keywords uppercase only, type names also in EF's lowercase
const TSQL_MARKERS = String.raw`\bWITH\s*\(\s*NOLOCK\s*\)|@@(ROWCOUNT|TRANCOUNT|FETCH_STATUS)\b|\bsp_executesql\b|\bSCOPE_IDENTITY\s*\(|\b(SYSUTCDATETIME|GETUTCDATE|NEWSEQUENTIALID)\s*\(|\bOUTPUT\s+(INSERTED|DELETED)\.|\bDECLARE\s+@\w|\bBEGIN\s+(TRY|TRAN)\b|\bCREATE\s+OR\s+ALTER\b|\bSET\s+(NOCOUNT|XACT_ABORT|IDENTITY_INSERT)\b|\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)|\b(NVARCHAR|VARCHAR|VARBINARY|nvarchar|varchar|varbinary)\s*\(\s*(MAX|max)\s*\)|\b(DATETIME2|datetime2)\b`
const TSQL = new RegExp(TSQL_MARKERS)
// .sql scripts are SQL by definition, so any case counts, plus GO batch separators
const TSQL_SCRIPT = new RegExp(String.raw`${TSQL_MARKERS}|^[ \t]*GO[ \t]*\d*[ \t]*$`, 'im')
// SERIAL only as a column type and ENGINE only with a storage engine, so a Serial column or an Engine value cannot veto; [ \t] keeps ^ from spanning lines
const OTHER_DIALECT_MARKERS = String.raw`(^|[(,]|\bADD([ \t]+COLUMN)?\b)[ \t]*(?!(SELECT|WHERE|AND|OR|BY|ON|SET|WHEN|THEN|ELSE|AS|DISTINCT)\b)["\`\w]{1,128}[ \t]+(BIG|SMALL)?SERIAL\b|\bAUTO_?INCREMENT\b|\bENGINE\s*=\s*(InnoDB|MyISAM|MEMORY|Aria|ARCHIVE|NDB|RocksDB)\b|\bON\s+CONFLICT\b|\bILIKE\b|\bJSONB\b|\bPRAGMA\s+\w|\bplpgsql\b|\bLIMIT\s+[\d@:?{]|\bVARCHAR2\b|::\s*(int|integer|bigint|text|uuid|jsonb?|numeric|timestamptz|regclass)\b`
const OTHER_DIALECT = new RegExp(String.raw`${OTHER_DIALECT_MARKERS}|\$\$|\`\w+\``, 'im')
// Code and strings that do not look like SQL: uppercase forms only, and no $$ or backticks, which raw strings and messages use
const OTHER_DIALECT_CODE = new RegExp(OTHER_DIALECT_MARKERS, 'm')

// The .NET and classic ASP repos this agent reviews run SQL Server, so provider-neutral raw SQL counts too unless another database shows up
const RAW_SQL_API = /^\s*(using\s+Dapper\s*;|Imports\s+Dapper\s*$)|\.(FromSql(Raw|Interpolated)?|ExecuteSql(Raw|Interpolated)?|SqlQuery(Raw)?|ExecuteNonQuery|ExecuteScalar|ExecuteReader|Query(First|Single)(OrDefault)?|QueryMultiple)(Async)?\s*(<[^>\n]{0,200}>)?\s*\(|\.(Query|Execute)(Async)?\s*(<[^>\n]{0,200}>)?\s*\(\s*(?![\w]{0,64}[Ss]qlite)\w{0,64}(sql|Sql|SQL)\w{0,64}\s*[,)]|\b(CommandText|I?Db(Connection|Command|Transaction|DataReader|DataAdapter|Parameter|DataParameter)|IDataReader|DbProviderFactory)\b/
// SELECT needs a FROM in the same string, checked apart so long strings stay linear; EXEC needs a procedure-shaped name so "EXECUTE ORDER" stays out
const SQL_SHAPE = String.raw`\bINSERT\s+INTO\s+[\w\[#@\`"]|\bUPDATE\s+[\w\[\].#@\`"]{1,128}\s+SET\s|\bDELETE\s+FROM\s+[\w\[#@\`"]|\b(EXEC|EXECUTE)\s+(dbo\.|sp_|@|\[|\w{1,128}\.\w)|\b(CREATE|ALTER|DROP)\s+(TABLE|VIEW|PROC|PROCEDURE|FUNCTION|INDEX|TRIGGER)\b|\bTRUNCATE\s+TABLE\s`
const SQL_SHAPE_UPPER = new RegExp(SQL_SHAPE)
const SQL_SHAPE_ANY = new RegExp(SQL_SHAPE, 'i')
// ADODB also fronts Access and MySQL ODBC, so it is provider-neutral like Dapper
const ADODB_OBJECT = /\bADODB\.(Connection|Command|Recordset)\b/i
// conn.Execute "…" / rs.Open "…" with the literal's text in `sql`; VBScript doubles quotes inside strings
const ADODB_CALL_STRING = /\.(Execute|Open)\b[ \t]*\(?[ \t]*"(?<sql>(?:[^"]|""){0,2000})/i
const ADODB_CALL_VAR = /\.(Execute|Open)\b[ \t]*\(?[ \t]*(?!\w{0,64}sqlite)\w{0,64}sql\w{0,64}[ \t]*([,)]|$)/i
const OTHER_DB_CONNSTR = /\bMicrosoft\.(Jet|ACE)\.OLEDB\b|\bMicrosoft Access Driver\b|\.(mdb|accdb)\b|\bDriver\s*=\s*\{MySQL|\bOraOLEDB\b|\bMSDAORA\b/i
const OTHER_DB_CLIENT = /Npgsql|\bMySql(Connector|Client|Connection|Command|DataReader|DataAdapter|Parameter|Transaction|Exception|BulkCopy|BulkLoader)\b|\bMySql\.(Data|EntityFrameworkCore)\b|\.EntityFrameworkCore\.(MySql|Sqlite)\b|\bMicrosoft\.Data\.Sqlite\b|\bSystem\.Data\.SQLite\b|\b(Sqlite|SQLite)(Async)?(Connection|Command|DataReader|Parameter|Transaction|Exception)\b|\bOracle\.(ManagedDataAccess|EntityFrameworkCore|DataAccess)\b|\bOracle(Connection|Command|DataReader|Parameter|Transaction|Exception)\b|\.Use(Npgsql|MySql|MySQL|Sqlite|SQLite|Oracle)\s*\(/

// Framework entrypoints often appear only as paths or manifest lines, so both path and diff markers count
const LARAVEL_PATH = /(^|\/)artisan$/
const LARAVEL_DIFF = /^[+ ][ \t]*use\s+Illuminate\\|^[+ ][ \t]*(final\s+|abstract\s+)?class\s+\w+\s+extends\s+Model\b|^[+ ].*laravel\/framework/m
const RAILS_PATH = /(^|\/)config\/routes\.rb$/
const RAILS_DIFF = /<\s*(ApplicationController|ApplicationRecord)\b|^[+ ].*\bRails\.|^[+ ][ \t]*gem\s+['"]rails['"]/m
const ANDROID_PATH = /(^|\/)AndroidManifest\.xml$/
const ANDROID_DIFF = /^[+ ][ \t]*import\s+androidx?\.|^[+ ].*com\.android\.(application|library)\b/m

// Extensionless scripts (bin/deploy) can't be classified by name, so the shebang in their diff section decides
const SHEBANG = /^[+ ]#!\s*\/\S*?(\/env\s+)?(ba|z|da|k)?sh\b/m
const DIFF_FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/gm

function shellShebangPaths(diff: string): Set<string> {
  const out = new Set<string>()
  const headers = [...diff.matchAll(DIFF_FILE_HEADER)]
  headers.forEach((h, i) => {
    const section = diff.slice(h.index, headers[i + 1]?.index ?? diff.length)
    if (SHEBANG.test(section)) out.add(h[2])
  })
  return out
}

type Lang = 'c' | 'vb' | 'vbs'

// New-file lines per hunk: '-' lines and the ---/+++ headers carry no new content; a diff without file headers is one unnamed section
function diffSections(diff: string): { ext: string; hunks: string[][] }[] {
  const keep = (l: string) => (l[0] === '+' || l[0] === ' ') && l.length <= MAX_SCAN_LINE
  const headers = [...diff.matchAll(SECTION_HEADER)]
  if (!headers.length) return [{ ext: '', hunks: [diff.split('\n').filter(l => keep(l) && !l.startsWith('+++ ')).map(l => l.slice(1))] }]
  return headers.map((h, i) => {
    const hunks: string[][] = []
    for (const line of diff.slice(h.index, headers[i + 1]?.index ?? diff.length).split('\n')) {
      if (line.startsWith('@@')) hunks.push([])
      else if (hunks.length && keep(line)) hunks[hunks.length - 1].push(line.slice(1))
    }
    return { ext: extensionOf(h[2]), hunks }
  })
}

// Comment-free lines (strings kept) plus every string literal's text, multi-line literals joined
function lex(lines: string[], lang: Lang): { kept: string[]; strings: string[] } {
  const kept: string[] = []
  const strings: string[] = []
  // raw = the opening quote count of a C# raw string (0 otherwise); it closes only on the same count
  let str: { text: string; raw: number; esc: boolean; multi: boolean } | null = null
  let block = false
  for (const line of lines) {
    let out = ''
    let i = 0
    while (i < line.length) {
      if (block) {
        const end = line.indexOf('*/', i)
        if (end < 0) break
        block = false
        i = end + 2
        continue
      }
      if (str) {
        let j = i
        if (str.raw) j = line.indexOf('"'.repeat(str.raw), i)
        else for (; j < line.length; j++) {
          if (str.esc && line[j] === '\\') j++
          else if (line[j] === '"') { if (str.esc || line[j + 1] !== '"') break; j++ }
        }
        if (j < 0 || j >= line.length) { str.text += line.slice(i); out += line.slice(i); break }
        const close = str.raw || 1
        str.text += line.slice(i, j)
        out += line.slice(i, j + close)
        strings.push(str.text)
        str = null
        i = j + close
        continue
      }
      const special = LEX_SPECIAL[lang]
      special.lastIndex = i
      const m = special.exec(line)
      out += line.slice(i, m ? m.index : line.length)
      if (!m) break
      i = m.index
      const c = line[i]
      if (lang === 'c' ? line.startsWith('//', i) : c === "'" || (m[0].length === 3 && /(^|:)\s*$/.test(out))) break
      if (lang === 'c' && line.startsWith('/*', i)) { block = true; i += 2; continue }
      if (lang === 'c' && c === "'") {
        const end = line.indexOf("'", i + (line[i + 1] === '\\' ? 3 : 2))
        out += "''"
        i = end < 0 ? line.length : end + 1
        continue
      }
      if (c === '"') {
        let quotes = 1
        while (line[i + quotes] === '"') quotes++
        const raw = lang === 'c' && quotes >= 3 ? quotes : 0
        const verbatim = lang === 'c' && (line[i - 1] === '@' || (line[i - 1] === '$' && line[i - 2] === '@'))
        str = { text: '', raw, esc: lang === 'c' && !raw && !verbatim, multi: raw > 0 || verbatim || lang === 'vb' }
        out += '"'.repeat(raw || 1)
        i += raw || 1
        continue
      }
      out += m[0]
      i += m[0].length
    }
    // C# regular and VBScript strings end with the line; verbatim, raw and VB.NET strings run on
    if (str && !str.multi) { strings.push(str.text); str = null } else if (str) str.text += '\n'
    kept.push(out)
  }
  if (str) strings.push(str.text)
  return { kept, strings }
}

// SQL with -- and /* */ comments dropped and '…' literals emptied, so comments and data cannot pose as syntax
function sqlText(lines: string[]): string {
  let block = false
  let literal = false
  return lines.map(line => {
    let out = ''
    let i = 0
    while (i < line.length) {
      if (block || literal) {
        const end = line.indexOf(block ? '*/' : "'", i)
        if (end < 0) break
        if (literal && line[end + 1] === "'") { i = end + 2; continue }
        if (literal) out += "'"
        i = end + (block ? 2 : 1)
        block = literal = false
        continue
      }
      SQL_SPECIAL.lastIndex = i
      const m = SQL_SPECIAL.exec(line)
      out += line.slice(i, m ? m.index : line.length)
      if (!m || m[0] === '--') break
      if (m[0] === '/*') block = true
      else { literal = true; out += "'" }
      i = m.index + m[0].length
    }
    return out
  }).join('\n')
}

// On a line with <% or %>, only the script parts are VBScript: an apostrophe in HTML (class='x', Don't) would otherwise comment out the script after it
function aspScript(line: string): string[] {
  const open = line.indexOf('<%')
  const close = line.indexOf('%>')
  if (open < 0 && close < 0) return [line]
  const parts: string[] = []
  let inScript = close >= 0 && (open < 0 || close < open)
  let i = 0
  for (;;) {
    const next = line.indexOf(inScript ? '%>' : '<%', i)
    if (inScript) parts.push(line.slice(i, next < 0 ? line.length : next))
    if (next < 0) return parts
    i = next + 2
    inScript = !inScript
  }
}

function looksLikeSql(text: string, anyCase: boolean): boolean {
  // All-caps text needs SQL-shaped punctuation, so labels like "DELETE FROM CART..." or "SELECT ITEMS FROM LIST (OPTIONAL)" stay UI copy
  if (!anyCase && !/[a-z]/.test(text) && !/[=@*\[]|\w\.\w|\w\(|\w[ \t]*,[ \t]*\w/.test(text)) return false
  if ((anyCase ? SQL_SHAPE_ANY : SQL_SHAPE_UPPER).test(text)) return true
  const select = text.search(anyCase ? /\bselect\s/i : /\bSELECT\s/)
  return select >= 0 && (anyCase ? /\bfrom\s+[\w\[#@(`"]/i : /\bFROM\s+[\w\[#@(`"]/).test(text.slice(select))
}

// SQL Server-only markers always count; provider-neutral SQL counts unless the diff shows another database
function hasSqlServerSignal(diff: string, paths: string[]): boolean {
  let neutral = paths.some(p => extensionOf(p) === 'sql')
  let veto = paths.some(p => ['mdb', 'accdb'].includes(extensionOf(p)))
  for (const { ext, hunks } of diffSections(diff)) {
    if (DOC_EXTENSIONS.has(ext)) continue
    const lang = CODE_LANG[ext]
    for (const hunk of hunks) {
      if (ext === 'sql') {
        const text = sqlText(hunk)
        if (OTHER_DIALECT.test(text)) veto = true
        else if (TSQL_SCRIPT.test(text)) return true
        continue
      }
      const { kept, strings } = lang ? lex(ext === 'asp' ? hunk.flatMap(aspScript) : hunk, lang) : { kept: hunk.filter(l => !COMMENT_LINE.test(l)), strings: [] }
      for (const line of kept) {
        if (SQLSERVER_CLIENT.test(line) || SQLSERVER_CONNSTR.test(line) || (!lang && TSQL.test(line))) return true
        if (RAW_SQL_API.test(line)) neutral = true
        if (OTHER_DB_CLIENT.test(line) || OTHER_DB_CONNSTR.test(line)) veto = true
        // Whole lines too: a hunk can start inside a multi-line SQL literal whose opening quote it never shows
        if (lang && OTHER_DIALECT_CODE.test(line)) veto = true
        if (!VBSCRIPT_EXTENSIONS.has(ext)) continue
        if (ADODB_OBJECT.test(line) || ADODB_CALL_VAR.test(line)) neutral = true
        const call = ADODB_CALL_STRING.exec(line)?.groups?.sql
        if (call !== undefined && looksLikeSql(call, true)) {
          const text = sqlText([call])
          if (OTHER_DIALECT.test(text)) veto = true
          else if (TSQL.test(text)) return true
          neutral = true
        }
      }
      if (ext === 'asp') continue
      for (const s of strings) {
        const sql = looksLikeSql(s, false)
        const text = sqlText(s.split('\n'))
        if ((sql ? OTHER_DIALECT : OTHER_DIALECT_CODE).test(text)) veto = true
        else if (TSQL.test(text)) return true
        else if (sql) neutral = true
      }
    }
  }
  return neutral && !veto
}

// AGENTS.md.template or config.json.example are the inner file's type; counted as 'other' they outvoted real stacks.
const WRAPPER_EXTENSIONS = new Set(['template', 'tmpl', 'example', 'sample', 'dist', 'in'])

function extensionOf(path: string): string {
  let base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  for (;;) {
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return ''
    const ext = base.slice(dot + 1)
    if (!WRAPPER_EXTENSIONS.has(ext)) return ext
    base = base.slice(0, dot)
  }
}

// 'other' = real source in an unsupported language; it counts against every base
function classifyFile(path: string, frontendSignal: boolean, shellScripts: Set<string>, vbMarkup: boolean): BaseStack | 'other' | null {
  const ext = extensionOf(path)
  if (!ext && shellScripts.has(path)) return 'shell'
  if (!ext || NEUTRAL_EXTENSIONS.has(ext)) return null
  if (FRONTEND_EXTENSIONS.has(ext)) return 'frontend'
  // Plain js/ts is ambiguous, so any frontend signal in the PR claims it for the frontend base
  if (JS_TS_EXTENSIONS.has(ext)) return frontendSignal ? 'frontend' : 'typescript-node'
  if (ext === 'java') return 'java'
  if (ext === 'kt' || ext === 'kts') return 'kotlin'
  // Jupyter cells are Python
  if (ext === 'py' || ext === 'ipynb') return 'python'
  // XAML has no language of its own; in a PR with VB and no C# it is VB markup
  if (vbMarkup && ext === 'xaml') return 'vbnet'
  // .NET: .razor/.cshtml/.xaml are .NET UI markup, not generic web — count them for the csharp base.
  if (ext === 'cs' || ext === 'csx' || ext === 'razor' || ext === 'cshtml' || ext === 'xaml') return 'csharp'
  if (ext === 'vb' || ext === 'vbhtml') return 'vbnet'
  // Classic ASP and WSH scripts; .inc stays other because PHP, Pascal and assembly use it too
  if (ext === 'asp' || ext === 'asa' || ext === 'vbs' || ext === 'wsf') return 'vbscript'
  if (ext === 'go') return 'go'
  if (ext === 'rs') return 'rust'
  if (ext === 'sh' || ext === 'bash' || ext === 'bats') return 'shell'
  if (ext === 'php' || ext === 'phpt') return 'php'
  if (['c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hh'].includes(ext)) return 'cpp'
  if (ext === 'swift') return 'swift'
  if (ext === 'tf' || ext === 'tfvars') return 'terraform'
  if (ext === 'rb') return 'ruby'
  if (ext === 'dart') return 'dart'
  if (ext === 'ps1' || ext === 'psm1') return 'powershell'
  return 'other'
}

export function detectStacks(changedFiles: ChangedFile[], diff = ''): StackSelection {
  const files = changedFiles.filter(f => f.status !== 'deleted')
  const paths = files.map(f => f.path)
  const anyPath = (re: RegExp) => paths.some(p => re.test(p))

  const angular = anyPath(ANGULAR_PATH) || ANGULAR_DIFF.test(diff)
  const ionic = anyPath(IONIC_PATH) || IONIC_DIFF.test(diff)
  const frontendSignal = angular || ionic || FRONTEND_DIFF.test(diff)
    || paths.some(p => ['tsx', 'jsx', 'vue', 'svelte'].includes(extensionOf(p)))

  const shellScripts = shellShebangPaths(diff)
  const hasExt = (ext: string) => paths.some(p => extensionOf(p) === ext)
  const vbMarkup = hasExt('vb') && !hasExt('cs')

  const counts = new Map<BaseStack | 'other', number>()
  let total = 0
  let dotnetProjects = 0
  for (const p of paths) {
    const kind = classifyFile(p, frontendSignal, shellScripts, vbMarkup)
    if (!kind) continue
    if (kind === 'other' && DOTNET_PROJECT_PATH.test(p)) dotnetProjects++
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    total++
  }

  let bases: BaseStack[] = total === 0 ? [] : BASE_STACKS
    .filter(b => (counts.get(b) ?? 0) / total >= BASE_FLOOR)
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))

  // Lazy so PRs without a .NET or classic ASP base never run the SQL regexes
  let sqlServerMemo: boolean | undefined
  const sqlServer = () => (sqlServerMemo ??= hasSqlServerSignal(diff, paths))

  // A code-less migration PR (.sql + project file) is .NET by its project file, but only a SQL Server change earns a base
  const csVotes = counts.get('csharp') ?? 0
  const vbVotes = counts.get('vbnet') ?? 0
  if (!bases.length && anyPath(DOTNET_PROJECT_PATH) && csVotes + vbVotes + dotnetProjects === total && sqlServer()) {
    const vbProjectOnly = !csVotes && !vbVotes && anyPath(/\.vbproj$/i) && !anyPath(/\.csproj$/i)
    bases = [vbVotes > csVotes || vbProjectOnly ? 'vbnet' : 'csharp']
  }
  if (!bases.length) return { bases: [], overlays: [] }

  const hasJvm = bases.includes('java') || bases.includes('kotlin')
  const hasFrontend = bases.includes('frontend')
  const hasCsharp = bases.includes('csharp')
  const hasVbnet = bases.includes('vbnet')
  const overlays: OverlayStack[] = []
  if (hasJvm && (anyPath(SPRING_PATH) || SPRING_DIFF.test(diff))) overlays.push('spring')
  if (hasFrontend && angular) overlays.push('angular')
  if (hasFrontend && ionic) overlays.push('ionic')
  if ((hasCsharp && (anyPath(ASPNET_PATH) || ASPNET_DIFF.test(diff)))
    || (hasVbnet && (anyPath(ASPNET_VB_PATH) || ASPNET_VB_DIFF.test(diff)))) overlays.push('aspnet')
  if (hasCsharp && (anyPath(BLAZOR_PATH) || BLAZOR_DIFF.test(diff))) overlays.push('blazor')
  if (hasCsharp && (anyPath(MAUI_PATH) || MAUI_DIFF.test(diff))) overlays.push('maui')
  if ((hasCsharp && (anyPath(WINFORMS_PATH) || WINFORMS_DIFF.test(diff)))
    || (hasVbnet && (anyPath(WINFORMS_VB_PATH) || WINFORMS_VB_DIFF.test(diff)))) overlays.push('winforms')
  // Classic ASP counts as well: the same shops run it on SQL Server through ADODB
  if ((hasCsharp || hasVbnet || bases.includes('vbscript')) && sqlServer()) overlays.push('sqlserver')
  if (bases.includes('php') && (anyPath(LARAVEL_PATH) || LARAVEL_DIFF.test(diff))) overlays.push('laravel')
  if (bases.includes('ruby') && (anyPath(RAILS_PATH) || RAILS_DIFF.test(diff))) overlays.push('rails')
  if (hasJvm && (anyPath(ANDROID_PATH) || ANDROID_DIFF.test(diff))) overlays.push('android')

  return { bases, overlays }
}
