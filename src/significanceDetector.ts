/**
 * Significance Detector — Determines if a code diff is architecturally significant.
 *
 * Replaces the old `minDiffLines` threshold. Instead of counting lines,
 * analyzes WHAT changed: new imports, new classes, new routes, schema changes,
 * config changes are significant. Formatting, comments, whitespace are not.
 *
 * Returns a classification with category for the decision type.
 */

export interface SignificanceResult {
    significant: boolean;
    category: string;  // 'dependency' | 'structure' | 'route' | 'schema' | 'config' | 'logic' | 'trivial'
    reason: string;
}

// Patterns that indicate architecturally significant changes.
// Each pattern has a regex, category, and human-readable reason.
const SIGNIFICANCE_PATTERNS: Array<{
    pattern: RegExp;
    category: string;
    reason: string;
}> = [
        // ─── New Dependencies / Imports ───
        {
            pattern: /^\+\s*(?:import\s+|from\s+\S+\s+import|const\s+\S+\s*=\s*require\(|require\()/m,
            category: 'dependency',
            reason: 'New dependency or import added',
        },
        // ─── New Class / Interface / Type Definitions ───
        {
            pattern: /^\+\s*(?:(?:export\s+)?(?:class|interface|type|enum|abstract\s+class)\s+\w+)/m,
            category: 'structure',
            reason: 'New class, interface, type, or enum defined',
        },
        // ─── New Function / Method Definitions (named, not anonymous) ───
        {
            pattern: /^\+\s*(?:(?:export\s+)?(?:async\s+)?function\s+\w+|(?:public|private|protected)\s+(?:async\s+)?\w+\s*\()/m,
            category: 'structure',
            reason: 'New function or method defined',
        },
        // ─── Route / Endpoint Definitions ───
        {
            pattern: /^\+\s*(?:app\.\s*(?:get|post|put|patch|delete|use)\s*\(|router\.\s*(?:get|post|put|patch|delete)\s*\(|@(?:Get|Post|Put|Patch|Delete|Route|RequestMapping)\b)/m,
            category: 'route',
            reason: 'New API route or endpoint defined',
        },
        // ─── Database / Schema Changes ───
        {
            pattern: /^\+\s*(?:CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|\.createTable|\.addColumn|schema\.\s*(?:create|table|define)|@Entity|@Table|@Column|model\s+\w+\s*\{)/im,
            category: 'schema',
            reason: 'Database schema or model change',
        },
        // ─── Config File Indicators ───
        {
            pattern: /^\+\s*(?:"(?:dependencies|devDependencies|scripts|compilerOptions)"\s*:|(?:DB_|API_|AUTH_|SECRET_|DATABASE_)\w+\s*=)/m,
            category: 'config',
            reason: 'Configuration or environment change',
        },
        // ─── Authentication / Security Patterns ───
        {
            pattern: /^\+\s*(?:(?:jwt|auth|token|session|cookie|oauth|bcrypt|hash|encrypt|decrypt|middleware)\w*\s*(?:=|\(|:))/im,
            category: 'logic',
            reason: 'Authentication or security pattern introduced',
        },
        // ─── State Management / Store ───
        {
            pattern: /^\+\s*(?:(?:createStore|createSlice|useReducer|createContext|useState)\s*\(|(?:export\s+)?const\s+\w*(?:Store|Context|Provider)\s*=)/m,
            category: 'structure',
            reason: 'State management pattern introduced',
        },
        // ─── Python-specific: new class, decorator, or function ───
        {
            pattern: /^\+\s*(?:class\s+\w+|def\s+\w+|@\w+(?:\.\w+)*\s*(?:\(|$))/m,
            category: 'structure',
            reason: 'New Python class, function, or decorator',
        },
    ];

// Patterns that indicate trivial / non-architectural changes
const TRIVIAL_PATTERNS: Array<RegExp> = [
    // Only comment changes
    /^[+-]\s*(?:\/\/|#|\/\*|\*\/|\*|<!--)/,
    // Only whitespace/formatting
    /^[+-]\s*$/,
    // Console.log / print statements only
    /^[+-]\s*(?:console\.(?:log|warn|error|info)|print\(|debugger)/,
];

/**
 * Check if a file is a config file (always significant when changed).
 */
const CONFIG_FILES = new Set([
    'package.json', 'tsconfig.json', 'webpack.config.js', 'vite.config.ts',
    '.env', '.env.local', '.env.production', 'docker-compose.yml',
    'Dockerfile', 'requirements.txt', 'pyproject.toml', 'Cargo.toml',
    'go.mod', 'pom.xml', 'build.gradle', '.eslintrc', '.prettierrc',
]);

/**
 * Analyze a diff to determine if it represents an architecturally significant change.
 *
 * @param diff - The unified diff text (lines prefixed with +/-)
 * @param fileName - The basename of the changed file
 * @returns SignificanceResult with classification
 */
export function detectSignificance(diff: string, fileName: string): SignificanceResult {
    // Config files are always significant
    if (CONFIG_FILES.has(fileName)) {
        return {
            significant: true,
            category: 'config',
            reason: `Config file changed: ${fileName}`,
        };
    }

    // Extract only the added/removed lines (ignore context lines)
    const changedLines = diff
        .split('\n')
        .filter(line => line.startsWith('+') || line.startsWith('-'))
        .filter(line => !line.startsWith('+++') && !line.startsWith('---'));

    if (changedLines.length === 0) {
        return { significant: false, category: 'trivial', reason: 'No actual changes' };
    }

    // Check if ALL changed lines are trivial
    const nonTrivialLines = changedLines.filter(line => {
        return !TRIVIAL_PATTERNS.some(pattern => pattern.test(line));
    });

    if (nonTrivialLines.length === 0) {
        return {
            significant: false,
            category: 'trivial',
            reason: 'Only comments, whitespace, or debug statements changed',
        };
    }

    // Check against significance patterns
    const diffText = changedLines.join('\n');

    for (const { pattern, category, reason } of SIGNIFICANCE_PATTERNS) {
        if (pattern.test(diffText)) {
            return { significant: true, category, reason };
        }
    }

    // If we have substantial non-trivial changes but no pattern match,
    // still mark as significant if there are enough meaningful lines
    if (nonTrivialLines.length >= 5) {
        return {
            significant: true,
            category: 'logic',
            reason: `${nonTrivialLines.length} non-trivial lines changed`,
        };
    }

    return {
        significant: false,
        category: 'trivial',
        reason: 'Change does not match any architectural significance pattern',
    };
}
