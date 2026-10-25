/** Secondary DA reported by the pinned xterm 6 frontend. Negotiate on loopback,
 * before tmux's timeout, rather than waiting for a phone round trip. */
export const secondaryDeviceAttributes = '\x1b[>0;276;0c';

/** Streaming CSI recognition; OSC/DCS payloads and all other controls pass through. */
class DeviceQueryFilter {
  private state: 'text' | 'escape' | 'csi' | 'string' | 'stringEscape' = 'text';
  private pending = '';
  private osc = false;
  constructor(private reply: () => void) {}
  write(data: string): string {
    let output = '';
    for (const char of data) {
      if (this.state === 'string' || this.state === 'stringEscape') {
        output += char;
        if (char === '\x9c' || (this.osc && char === '\x07') || (this.state === 'stringEscape' && char === '\\')) this.state = 'text';
        else this.state = char === '\x1b' ? 'stringEscape' : 'string';
      } else if (this.state === 'text') {
        if (char === '\x1b') { this.pending = char; this.state = 'escape'; }
        else if (char === '\x9b') { this.pending = char; this.state = 'csi'; }
        else { output += char; if (['\x90', '\x98', '\x9d', '\x9e', '\x9f'].includes(char)) { this.osc = char === '\x9d'; this.state = 'string'; } }
      } else if (this.state === 'escape') {
        if (char === '[') { this.pending += char; this.state = 'csi'; }
        else if (['P', 'X', ']', '^', '_'].includes(char)) { output += this.pending + char; this.pending = ''; this.osc = char === ']'; this.state = 'string'; }
        else if (char === '\x1b') output += char;
        else { output += this.pending + char; this.pending = ''; this.state = 'text'; }
      } else {
        if (char === '\x1b') { output += this.pending; this.pending = char; this.state = 'escape'; continue; }
        this.pending += char;
        if (char >= '@' && char <= '~') {
          if (/^(?:\x1b\[|\x9b)>0*c$/.test(this.pending)) this.reply();
          else output += this.pending;
          this.pending = ''; this.state = 'text';
        } else if (this.pending.length > 256 || char === '\x18' || char === '\x1a') { output += this.pending; this.pending = ''; this.state = 'text'; }
      }
    }
    return output;
  }
}

export class TerminalNegotiation {
  private output: DeviceQueryFilter;
  constructor(reply: (data: string) => void) { this.output = new DeviceQueryFilter(() => reply(secondaryDeviceAttributes)); }
  serverOutput(data: string) { return this.output.write(data); }
  clientInput(data: string) {
    // xterm emits a complete automatic DA response in one onData event. Drop
    // duplicate/late responses from old clients, preserving Escape/arrow keys
    // immediately (never wait for a later key to complete a possible CSI).
    return data.replace(/(?:\x1b\[|\x9b)>[0-9]+;[0-9]+;[0-9]+c/g, '');
  }
}
