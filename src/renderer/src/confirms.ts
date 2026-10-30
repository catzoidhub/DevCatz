import { askConfirm, state } from './store';
import { isWin } from './platform';

/** The confirmations of actions that change the system or cannot be undone, in DevCatz's own dialog (askConfirm). */

export const confirmDiscard = (files: string[]) =>
  askConfirm({
    title: files.length === 1 ? `Discard the changes to ${files[0]}?` : `Discard the changes to ${files.length} files?`,
    text: 'Edits are lost and new (untracked) files are deleted. This cannot be undone.',
    confirm: 'Discard',
  });

export const confirmDeleteBucket = (bucket: string) =>
  askConfirm({ title: `Delete the bucket "${bucket}"?`, text: 'Every object in it is deleted too. This cannot be undone.', confirm: 'Delete bucket' });

export const confirmDeleteObject = (key: string) =>
  askConfirm({
    title: key.endsWith('/') ? `Delete the folder "${key}" and everything in it?` : `Delete "${key}"?`,
    text: 'This cannot be undone.',
    confirm: 'Delete',
  });

export function confirmTrustCa(): Promise<boolean> {
  const tld = state.value?.settings.tld ?? 'localhost';
  return askConfirm({
    title: 'Trust the DevCatz local certificate authority?',
    text: isWin
      ? `The CA is created on this PC and only signs certificates for your *.${tld} sites. It goes into your own Trusted Root certificates (no administrator needed); Windows asks you to confirm next. You can remove it again from Settings.`
      : `The CA is created on this Mac and only signs certificates for your *.${tld} sites. It will be added to your login keychain as trusted for SSL; macOS asks for your password next. You can remove it again from Settings.`,
    confirm: isWin ? 'Add to Windows' : 'Add to Keychain',
    tone: 'primary',
  });
}

export function confirmCleanUrls(): Promise<boolean> {
  const s = state.value?.settings;
  const https = s?.httpsPort ?? 8443;
  const http = s?.httpPort ?? 8080;
  return askConfirm({
    title: 'Serve sites without a port number?',
    text: isWin
      ? `Windows' port proxy (the IP Helper service) will relay [::1]:443 and [::1]:80 to the proxy on ${https} / ${http}, and 127.0.0.1 too when no other app uses those ports. The rules stay after a restart; Windows asks for administrator approval next.`
      : `DevCatz will install two LaunchDaemons: launchd listens on [::1]:443 and [::1]:80 and relays each connection with /usr/bin/nc (running as "nobody") to the proxy on ${https} / ${http}. 127.0.0.1:80/443 stay with any app already using them. Files: /Library/LaunchDaemons/com.mrcatz.herd.forward-https.plist and -http.plist; macOS asks for an administrator password next.`,
    confirm: 'Enable',
    tone: 'primary',
  });
}

export function confirmResolver(): Promise<boolean> {
  const t = state.value?.settings.tld ?? 'test';
  return askConfirm({
    title: `Resolve *.${t} to this Mac?`,
    text: `DevCatz will create /etc/resolver/${t} so macOS asks DevCatz's own DNS (127.0.0.1:53531) for *.${t} names. Nothing else on the network changes. macOS asks for an administrator password next.`,
    confirm: 'Install',
    tone: 'primary',
  });
}

export const confirmOverwrite = (files: string[]) =>
  askConfirm({ title: `Overwrite ${files.length} existing file${files.length === 1 ? '' : 's'}?`, text: files.join(', '), confirm: 'Overwrite', tone: 'warning' });
