declare module '@vscode/sudo-prompt' {
  export interface ExecOptions {
    name?: string;
    icns?: string;
    env?: { [key: string]: string };
  }

  export function exec(
    command: string,
    options: ExecOptions,
    callback: (error?: Error, stdout?: string | Buffer, stderr?: string | Buffer) => void
  ): void;
}
