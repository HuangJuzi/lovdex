import { promises as fs } from "fs";
import os from "os";
import path from "path";

import express from "express";

import { providerModelsService } from "../modules/providers/services/provider-models.service.js";
import { parseFrontMatter } from "../shared/frontmatter.js";
import { findAppRoot, getModuleDir } from "../utils/runtime-paths.js";

const __dirname = getModuleDir(import.meta.url);
// This route reads the top-level package.json for the status command, so it needs the real
// app root even after compilation moves the route file under dist-server/server/routes.
const APP_ROOT = findAppRoot(__dirname);

const router = express.Router();

const MODEL_PROVIDERS = ["claude", "codex", "opencode", "qoder"];

const MODEL_PROVIDER_LABELS = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  qoder: "Qoder",
};

const readModelProvider = (value) => {
  if (typeof value !== "string") {
    return "claude";
  }

  const normalized = value.trim().toLowerCase();
  return MODEL_PROVIDERS.includes(normalized) ? normalized : "claude";
};

const hasConcreteSessionId = (value) =>
  typeof value === "string" && value.trim().length > 0;

// When there is no active session yet (e.g. a brand-new chat before the first
// response), the backend has no jsonl transcript to read the active model from.
// Previously this fell back to the provider's hardcoded `catalog.DEFAULT`, so
// the /model modal always showed "default" even right after the user picked a
// concrete model — the user's selection lives in the frontend's localStorage
// (`claude-model` etc.) and is passed back here as `context.model`. Prefer that
// requested model so the modal reflects what the next response will actually use.
const resolveCommandModel = async (provider, catalog, sessionId, requestedModel) => {
  if (!hasConcreteSessionId(sessionId)) {
    return requestedModel || catalog.DEFAULT;
  }

  // The persisted session model change is the source of truth for what the next
  // response will actually use (resolveResumeModel applies it on the next turn).
  // Prefer it over the transcript so the /model modal reflects a selection
  // immediately instead of only after the next response has run and the jsonl
  // transcript has caught up.
  const pendingChange = await providerModelsService.getChangedActiveModel(provider, sessionId);
  if (pendingChange.supported && pendingChange.changed && pendingChange.model?.trim()) {
    return pendingChange.model.trim();
  }

  const currentActiveModel = await providerModelsService.getCurrentActiveModel(
    provider,
    sessionId,
  );
  return currentActiveModel?.model || requestedModel || catalog.DEFAULT;
};

export const executeModelsCommand = async (args, context) => {
  const currentProvider = readModelProvider(context?.provider);
  const result = await providerModelsService.getProviderModels(currentProvider);
  const catalog = result.models;
  const currentModel = await resolveCommandModel(
    currentProvider,
    catalog,
    context?.sessionId,
    context?.model,
  );
  const availableModels = catalog.OPTIONS.map((option) => option.value);
  const availableOptions = catalog.OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }));

  return {
    type: "builtin",
    action: "models",
    data: {
      current: {
        provider: currentProvider,
        providerLabel: MODEL_PROVIDER_LABELS[currentProvider],
        model: currentModel,
      },
      available: {
        [currentProvider]: availableModels,
      },
      availableModels,
      availableOptions,
      defaultModel: catalog.DEFAULT,
      cache: result.cache,
      message: `Current model: ${currentModel}`,
    },
  };
};

/**
 * Recursively scan directory for command files (.md)
 * @param {string} dir - Directory to scan
 * @param {string} baseDir - Base directory for relative paths
 * @param {string} namespace - Namespace for commands (e.g., 'project', 'user')
 * @returns {Promise<Array>} Array of command objects
 */
async function scanCommandsDirectory(dir, baseDir, namespace) {
  const commands = [];

  try {
    // Check if directory exists
    await fs.access(dir);

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        const subCommands = await scanCommandsDirectory(
          fullPath,
          baseDir,
          namespace,
        );
        commands.push(...subCommands);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Parse markdown file for metadata
        try {
          const content = await fs.readFile(fullPath, "utf8");
          const { data: frontmatter, content: commandContent } =
            parseFrontMatter(content);

          // Calculate relative path from baseDir for command name
          const relativePath = path.relative(baseDir, fullPath);
          // Remove .md extension and convert to command name
          const commandName =
            "/" + relativePath.replace(/\.md$/, "").replace(/\\/g, "/");

          // Extract description from frontmatter or first line of content
          let description = frontmatter.description || "";
          if (!description) {
            const firstLine = commandContent.trim().split("\n")[0];
            description = firstLine.replace(/^#+\s*/, "").trim();
          }

          commands.push({
            name: commandName,
            path: fullPath,
            relativePath,
            description,
            namespace,
            metadata: frontmatter,
          });
        } catch (err) {
          console.error(`Error parsing command file ${fullPath}:`, err.message);
        }
      }
    }
  } catch (err) {
    // Directory doesn't exist or can't be accessed - this is okay
    if (err.code !== "ENOENT" && err.code !== "EACCES") {
      console.error(`Error scanning directory ${dir}:`, err.message);
    }
  }

  return commands;
}

/**
 * Built-in commands that are always available
 */
export const builtInCommands = [
  {
    name: "/help",
    description: "Show help documentation for Claude Code",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/clear",
    description: "Clear the conversation and start a new chat (forwarded to the provider)",
    namespace: "builtin",
    metadata: { type: "builtin", forwardToProvider: true },
  },
  {
    name: "/compact",
    description: "Summarize the conversation to free up context (forwarded to the provider)",
    namespace: "builtin",
    metadata: { type: "builtin", forwardToProvider: true },
  },
  {
    name: "/model",
    description: "View available models for the current provider",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/cost",
    description: "Display token usage information",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/memory",
    description: "Open CLAUDE.md memory file for editing",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/config",
    description: "Open settings and configuration",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/status",
    description: "Show system status and version information",
    namespace: "builtin",
    metadata: { type: "builtin" },
  },
  {
    name: "/resume",
    description: "Resume an earlier conversation (opens a session picker)",
    namespace: "builtin",
    metadata: { type: "builtin", handler: "ui-overlay", overlay: "resume" },
  },
  {
    name: "/branch",
    description: "Branch this conversation from a chosen turn",
    namespace: "builtin",
    metadata: { type: "builtin", handler: "ui-overlay", overlay: "branch" },
  },
  {
    name: "/fork",
    description: "Fork this conversation into a new session",
    namespace: "builtin",
    metadata: { type: "builtin", handler: "ui-overlay", overlay: "fork" },
  },
  {
    name: "/rewind",
    description: "Rewind code and conversation to a chosen turn",
    namespace: "builtin",
    metadata: { type: "builtin", handler: "ui-overlay", overlay: "rewind" },
  },
];

/**
 * Commands that are forwarded verbatim to the provider as a normal user
 * message (e.g. `/clear`, `/compact`). Both Claude Code and Codex natively
 * interpret these slash commands when they arrive as the prompt, so the app
 * does not implement the behavior itself — it just routes the raw command
 * text through the normal chat-send path. The frontend's slash-command
 * interception is told (via `metadata.forwardToProvider`) to let these fall
 * through to a regular send instead of dispatching to a builtin handler.
 *
 * Returns a `custom`-shaped result so the existing `handleCustomCommand`
 * path sets the command text as the input and submits it, which then
 * falls through the (skipped) interception and reaches `chat.send`.
 */
const forwardToProviderCommand = (commandName) => async (args) => {
  const argStr = Array.isArray(args) && args.length > 0 ? ` ${args.join(" ")}` : "";
  return {
    type: "custom",
    content: `${commandName}${argStr}`,
    hasBashCommands: false,
    isForwarded: true,
  };
};

/**
 * Built-in command handlers
 * Each handler returns { type: 'builtin', action: string, data: any }
 */
const builtInHandlers = {
  "/help": async (args, context) => {
    const helpText = `# Claude Code Commands

## Built-in Commands

${builtInCommands
  .map(
    (cmd) => `### ${cmd.name}
${cmd.description}
`,
  )
  .join("\n")}

## Custom Commands

Custom commands can be created in:
- Project: \`.claude/commands/\` (project-specific)
- User: \`~/.claude/commands/\` (available in all projects)

### Command Syntax

- **Arguments**: Use \`$ARGUMENTS\` for all args or \`$1\`, \`$2\`, etc. for positional
- **File Includes**: Use \`@filename\` to include file contents
- **Bash Commands**: Use \`!command\` to execute bash commands

### Examples

\`\`\`markdown
/mycommand arg1 arg2
\`\`\`
`;

    return {
      type: "builtin",
      action: "help",
      data: {
        content: helpText,
        format: "markdown",
        commands: builtInCommands.map((command) => ({
          name: command.name,
          description: command.description,
          namespace: command.namespace,
        })),
      },
    };
  },

  "/model": executeModelsCommand,

  // Forwarded to the provider as a normal user message (see
  // forwardToProviderCommand). The frontend skips interception for these via
  // metadata.forwardToProvider, so they never need a builtin action handler.
  "/clear": forwardToProviderCommand("/clear"),
  "/compact": forwardToProviderCommand("/compact"),

  "/cost": async (args, context) => {
    const tokenUsage = context?.tokenUsage || {};
    const provider = readModelProvider(context?.provider);
    const catalog = (await providerModelsService.getProviderModels(provider)).models;
    const model = await resolveCommandModel(
      provider,
      catalog,
      context?.sessionId,
      context?.model,
    );

    const reportedUsed =
      Number(
        tokenUsage.used ?? tokenUsage.totalUsed ?? tokenUsage.total_tokens ?? 0,
      ) || 0;
    const total =
      Number(
        tokenUsage.total ??
          tokenUsage.contextWindow ??
          0,
      ) || 0;
    const normalizedInputValue =
      tokenUsage.inputTokens ??
      tokenUsage.input ??
      tokenUsage.cumulativeInputTokens ??
      tokenUsage.breakdown?.input ??
      tokenUsage.promptTokens;
    const directInputTokens =
      Number(
        normalizedInputValue ??
          tokenUsage.input_tokens ??
          0
      ) || 0;
    const cacheReadTokens =
      Number(
        tokenUsage.cacheReadTokens ??
          tokenUsage.cache_read_input_tokens ??
          tokenUsage.cacheReadInputTokens ??
          0,
      ) || 0;
    const cacheCreationTokens =
      Number(
        tokenUsage.cacheCreationTokens ??
          tokenUsage.cache_creation_input_tokens ??
          tokenUsage.cacheCreationInputTokens ??
          0,
      ) || 0;
    const inputTokens = normalizedInputValue == null
      ? directInputTokens + cacheReadTokens + cacheCreationTokens
      : directInputTokens;
    const outputTokens =
      Number(
        tokenUsage.outputTokens ??
          tokenUsage.output ??
          tokenUsage.output_tokens ??
          tokenUsage.cumulativeOutputTokens ??
          tokenUsage.breakdown?.output ??
          tokenUsage.completionTokens ??
          0,
      ) || 0;
    const computedUsed = inputTokens + outputTokens;
    const hasTokenBreakdown = computedUsed > 0;
    const used = Math.max(reportedUsed, computedUsed);

    return {
      type: "builtin",
      action: "cost",
      data: {
        tokenUsage: {
          used,
          total,
        },
        ...(hasTokenBreakdown
          ? {
              tokenBreakdown: {
                input: inputTokens,
                output: outputTokens,
              },
            }
          : {}),
        provider,
        model,
      },
    };
  },

  "/status": async (args, context) => {
    // Read version from package.json
    const packageJsonPath = path.join(APP_ROOT, "package.json");
    let version = "unknown";
    let packageName = "claude-code-ui";

    try {
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, "utf8"),
      );
      version = packageJson.version;
      packageName = packageJson.name;
    } catch (err) {
      console.error("Error reading package.json:", err);
    }

    const uptime = process.uptime();
    const uptimeMinutes = Math.floor(uptime / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const uptimeFormatted =
      uptimeHours > 0
        ? `${uptimeHours}h ${uptimeMinutes % 60}m`
        : `${uptimeMinutes}m`;

    const statusProvider = readModelProvider(context?.provider);
    const statusCatalog = (await providerModelsService.getProviderModels(statusProvider)).models;
    const model = await resolveCommandModel(
      statusProvider,
      statusCatalog,
      context?.sessionId,
      context?.model,
    );
    const memoryUsage = process.memoryUsage();

    return {
      type: "builtin",
      action: "status",
      data: {
        version,
        packageName,
        uptime: uptimeFormatted,
        uptimeSeconds: Math.floor(uptime),
        model,
        provider: statusProvider,
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        memoryUsage: {
          rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
          heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        },
      },
    };
  },

  "/memory": async (args, context) => {
    const projectPath = context?.projectPath;

    if (!projectPath) {
      return {
        type: "builtin",
        action: "memory",
        data: {
          error: "No project selected",
          message: "Please select a project to access its CLAUDE.md file",
        },
      };
    }

    const claudeMdPath = path.join(projectPath, "CLAUDE.md");

    // Check if CLAUDE.md exists
    let exists = false;
    try {
      await fs.access(claudeMdPath);
      exists = true;
    } catch (err) {
      // File doesn't exist
    }

    return {
      type: "builtin",
      action: "memory",
      data: {
        path: claudeMdPath,
        exists,
        message: exists
          ? `Opening CLAUDE.md at ${claudeMdPath}`
          : `CLAUDE.md not found at ${claudeMdPath}. Create it to store project-specific instructions.`,
      },
    };
  },

  "/config": async (args, context) => {
    return {
      type: "builtin",
      action: "config",
      data: {
        message: "Opening settings...",
      },
    };
  },
};

/**
 * POST /api/commands/list
 * List all available commands from project and user directories
 */
router.post("/list", async (req, res) => {
  try {
    const { projectPath } = req.body;
    const allCommands = [...builtInCommands];

    // Scan project-level commands (.claude/commands/)
    if (projectPath) {
      const projectCommandsDir = path.join(projectPath, ".claude", "commands");
      const projectCommands = await scanCommandsDirectory(
        projectCommandsDir,
        projectCommandsDir,
        "project",
      );
      allCommands.push(...projectCommands);
    }

    // Scan user-level commands (~/.claude/commands/)
    const homeDir = os.homedir();
    const userCommandsDir = path.join(homeDir, ".claude", "commands");
    const userCommands = await scanCommandsDirectory(
      userCommandsDir,
      userCommandsDir,
      "user",
    );
    allCommands.push(...userCommands);

    // Separate built-in and custom commands
    const customCommands = allCommands.filter(
      (cmd) => cmd.namespace !== "builtin",
    );

    // Sort commands alphabetically by name
    customCommands.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      builtIn: builtInCommands,
      custom: customCommands,
      count: allCommands.length,
    });
  } catch (error) {
    console.error("Error listing commands:", error);
    res.status(500).json({
      error: "Failed to list commands",
      message: error.message,
    });
  }
});

/**
 * POST /api/commands/execute
 * Execute a command with argument replacement
 * This endpoint prepares the command content but doesn't execute bash commands yet
 * (that will be handled in the command parser utility)
 */
router.post("/execute", async (req, res) => {
  try {
    const { commandName, commandPath, args = [], context = {} } = req.body;

    if (!commandName) {
      return res.status(400).json({
        error: "Command name is required",
      });
    }

    // Handle built-in commands
    const handler = builtInHandlers[commandName];
    if (handler) {
      try {
        const result = await handler(args, context);
        return res.json({
          ...result,
          command: commandName,
        });
      } catch (error) {
        console.error(
          `Error executing built-in command ${commandName}:`,
          error,
        );
        return res.status(500).json({
          error: "Command execution failed",
          message: error.message,
          command: commandName,
        });
      }
    }

    // Handle custom commands
    if (!commandPath) {
      return res.status(400).json({
        error: "Command path is required for custom commands",
      });
    }

    // Load command content
    // Security: validate commandPath is within allowed directories
    {
      const resolvedPath = path.resolve(commandPath);
      const userBase = path.resolve(
        path.join(os.homedir(), ".claude", "commands"),
      );
      const projectBase = context?.projectPath
        ? path.resolve(path.join(context.projectPath, ".claude", "commands"))
        : null;
      const isUnder = (base) => {
        const rel = path.relative(base, resolvedPath);
        return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      };
      if (!(isUnder(userBase) || (projectBase && isUnder(projectBase)))) {
        return res.status(403).json({
          error: "Access denied",
          message: "Command must be in .claude/commands directory",
        });
      }
    }
    const content = await fs.readFile(commandPath, "utf8");
    const { data: metadata, content: commandContent } =
      parseFrontMatter(content);
    // Basic argument replacement (will be enhanced in command parser utility)
    let processedContent = commandContent;

    // Replace $ARGUMENTS with all arguments joined
    const argsString = args.join(" ");
    processedContent = processedContent.replace(/\$ARGUMENTS/g, argsString);

    // Replace $1, $2, etc. with positional arguments
    args.forEach((arg, index) => {
      const placeholder = `$${index + 1}`;
      processedContent = processedContent.replace(
        new RegExp(`\\${placeholder}\\b`, "g"),
        arg,
      );
    });

    res.json({
      type: "custom",
      command: commandName,
      content: processedContent,
      metadata,
      hasFileIncludes: processedContent.includes("@"),
      hasBashCommands: processedContent.includes("!"),
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return res.status(404).json({
        error: "Command not found",
        message: `Command file not found: ${req.body.commandPath}`,
      });
    }

    console.error("Error executing command:", error);
    res.status(500).json({
      error: "Failed to execute command",
      message: error.message,
    });
  }
});

export default router;
