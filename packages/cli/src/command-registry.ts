import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export type CommandResult = Record<string, unknown>;

export type LocalCommandContext = {
  positionals: string[];
  flags: Map<string, string>;
};

export type McpCommandContext = LocalCommandContext & {
  client: Client;
};

export type LocalCommandDefinition = {
  name: string;
  description: string;
  transport: 'local';
  validate?: (context: LocalCommandContext) => void;
  run: (context: LocalCommandContext) => CommandResult | Promise<CommandResult>;
};

export type McpCommandDefinition = {
  name: string;
  description: string;
  transport: 'mcp';
  validate?: (context: LocalCommandContext) => void;
  run: (context: McpCommandContext) => CommandResult | Promise<CommandResult>;
};

export type CliCommandDefinition = LocalCommandDefinition | McpCommandDefinition;

export type CommandRegistry = {
  get: (name: string) => CliCommandDefinition | undefined;
  descriptions: () => Record<string, string>;
};

// These commands are still dispatched by the composition root. Feature
// modules may not shadow them, even when a legacy command appears after the
// feature registry lookup or has stricter mutation guards of its own.
export const LEGACY_COMMAND_NAMES = new Set([
  'help',
  '--help',
  '-h',
  'auth',
  'api-auth',
  'api',
  'message',
  'create-thread',
  'repositories',
  'branches',
  'repo-inspect',
  'project',
  'messages',
  'thread-capability',
  'thread-usage',
  'thread-pr-status',
  'thread-pr-comments',
  'thread-preview-checklist',
  'thread-stop',
  'thread-retry',
  'thread-compact',
  'thread-auto-title',
  'projects',
  'threads',
  'status',
  'inspect',
  'models',
  'tools',
]);

export function createCommandRegistry(
  groups: readonly (readonly CliCommandDefinition[])[],
): CommandRegistry {
  const commands = new Map<string, CliCommandDefinition>();
  for (const group of groups) {
    for (const command of group) {
      if (LEGACY_COMMAND_NAMES.has(command.name)) {
        throw new Error(`Registered command shadows reserved legacy command: ${command.name}`);
      }
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(command.name)) {
        throw new Error(`Invalid registered command name: ${command.name}`);
      }
      if (commands.has(command.name)) throw new Error(`Duplicate registered command: ${command.name}`);
      commands.set(command.name, command);
    }
  }
  return {
    get: name => commands.get(name),
    descriptions: () => Object.fromEntries(
      [...commands.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(command => [command.name, command.description]),
    ),
  };
}
