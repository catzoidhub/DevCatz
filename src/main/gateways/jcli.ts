import { connect } from 'node:net';

/**
 * Drives Jasmin's jCli (its telnet management console): logs in, sends each
 * command after the prompt and returns the whole transcript. jCli prompts
 * with "jcli : " at top level and "> " inside an add/update block; the
 * login asks for the username after "Authentication required." without a prompt.
 */
export function jcli(host: string, port: number, user: string, password: string, commands: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let out = '';
    let buf = '';
    let stage: 'user' | 'pass' | 'cmds' = 'user';
    let i = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`jCli did not answer in time: ${out.trim().split('\n').slice(-2).join(' ')}`));
    }, timeoutMs);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(out);
    };
    socket.on('error', (e) => finish(e));
    socket.on('data', (d: Buffer) => {
      // Strip telnet negotiation (IAC sequences) before reading prompts.
      const text = d.toString('latin1').replace(/\xff[\xfb-\xfe]./g, '').replace(/\xff./g, '');
      out += text;
      buf += text;
      if (stage === 'user' && /(Username:|Authentication required\.)[\s\r\n]*$/i.test(buf)) {
        buf = '';
        stage = 'pass';
        socket.write(`${user}\r\n`);
      } else if (stage === 'pass' && /Password:\s*$/i.test(buf)) {
        buf = '';
        stage = 'cmds';
        socket.write(`${password}\r\n`);
      } else if (stage === 'cmds' && /(jcli : |> )\s*$/.test(buf)) {
        if (/Incorrect Username\/Password/i.test(buf)) return finish(new Error('jCli login failed'));
        buf = '';
        if (i >= commands.length) {
          socket.write('quit\r\n');
          return finish();
        }
        socket.write(`${commands[i++]}\r\n`);
      }
    });
    // Closed before the console answered (Docker's port proxy accepts before Jasmin listens): an error, so callers retry.
    socket.on('close', () => (stage === 'cmds' && i > 0 ? finish() : finish(new Error('jCli closed the connection before logging in'))));
  });
}
