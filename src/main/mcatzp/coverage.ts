import type { HerdApi } from '@shared/types';

/**
 * Every action DevCatz can do, and where it stands with MCatzP (scope: every action, user 2026-10-28). A new method in
 * HerdApi fails the typecheck here until it is placed, so nothing is left out unnoticed.
 * `tool: …` is done. `later: …` is still to do, in that tier. `not a tool`: it only makes sense in the window (a menu, a
 * file picker, this app's own updater or AI buttons). `never: …`: left out on purpose, with why.
 */
export const MCATZP_COVERAGE = {
  // tool: cancel_install
  installCancel: 'tool: cancel_install',
  dbCancelCreate: 'tool: cancel_install',
  searchCancelInstall: 'tool: cancel_install',
  waCancelInstall: 'tool: cancel_install',
  gwCancelInstall: 'tool: cancel_install',
  wsCancelInstall: 'tool: cancel_install',
  storageCancelInstall: 'tool: cancel_install',
  // tool: create_database
  dbCreateDatabase: 'tool: create_database',
  // tool: create_service
  dbDefaults: 'tool: create_service',
  dbCreate: 'tool: create_service',
  // tool: deps_report
  depsReport: 'tool: deps_report',
  // tool: docker_cancel
  dockerCancel: 'tool: docker_cancel',
  // tool: docker_compose
  dockerCompose: 'tool: docker_compose',
  // tool: docker_dev_write
  dockerDevWrite: 'tool: docker_dev_write',
  // tool: docker_env_replace
  dockerDocatzEnvReplace: 'tool: docker_env_replace',
  // tool: docker_save_file
  dockerSaveFile: 'tool: docker_save_file',
  // tool: docker_status
  dockerStatus: 'tool: docker_status',
  // tool: docker_write
  dockerWrite: 'tool: docker_write',
  // tool: domain_owner
  domainOwner: 'tool: domain_owner',
  // tool: expose_requests
  exposeRequests: 'tool: expose_requests',
  // tool: get_status
  mailForwardConfig: 'tool: get_status',
  // tool: git_add_remote
  gitAddRemote: 'tool: git_add_remote',
  // tool: git_branch (delete: later, destructive)
  gitBranch: 'tool: git_branch (delete: later, destructive)',
  // tool: git_cancel
  gitCancel: 'tool: git_cancel',
  // tool: git_cancel_clone
  gitCancelClone: 'tool: git_cancel_clone',
  // tool: git_checkout_pull
  gitCheckoutPull: 'tool: git_checkout_pull',
  // tool: git_cherry_pick
  gitCherryPick: 'tool: git_cherry_pick',
  // tool: git_clone
  gitClone: 'tool: git_clone',
  // tool: git_commit (amend: later, destructive)
  gitCommit: 'tool: git_commit (amend: later, destructive)',
  // tool: git_create_pull
  gitCreatePull: 'tool: git_create_pull',
  // tool: git_ignore_add
  gitIgnoreAdd: 'tool: git_ignore_add',
  // tool: git_ignore_save
  gitignoreSave: 'tool: git_ignore_save',
  // tool: git_init
  gitInit: 'tool: git_init',
  // tool: git_rebase
  gitOperation: 'tool: git_rebase',
  // tool: git_stage
  gitStage: 'tool: git_stage',
  // tool: git_stash (drop: later, destructive)
  gitStash: 'tool: git_stash (drop: later, destructive)',
  // tool: git_sync (force push: later, destructive)
  gitSync: 'tool: git_sync (force push: later, destructive)',
  // tool: git_tag (delete: later, destructive)
  gitTag: 'tool: git_tag (delete: later, destructive)',
  // tool: git_unstage
  gitUnstage: 'tool: git_unstage',
  // tool: install_runtime
  nodeInstall: 'tool: install_runtime',
  bunInstall: 'tool: install_runtime',
  goInstall: 'tool: install_runtime',
  pythonInstall: 'tool: install_runtime',
  phpInstall: 'tool: install_runtime',
  // tool: install_runtime_tool
  toolInstall: 'tool: install_runtime_tool',
  // tool: install_service
  searchInstall: 'tool: install_service',
  waInstall: 'tool: install_service',
  gwInstall: 'tool: install_service',
  wsInstall: 'tool: install_service',
  storageInstall: 'tool: install_service',
  // tool: list_databases
  dbList: 'tool: list_databases',
  // tool: list_db_engines
  dbEngines: 'tool: list_db_engines',
  // tool: list_db_versions
  dbVersions: 'tool: list_db_versions',
  // tool: list_external_databases
  dbDetect: 'tool: list_external_databases',
  // tool: list_git_repos
  gitRepos: 'tool: list_git_repos',
  // tool: list_herd_sites
  herdSites: 'tool: list_herd_sites',
  // tool: list_runtime_tools
  toolsState: 'tool: list_runtime_tools',
  // tool: list_runtime_versions
  nodeRemote: 'tool: list_runtime_versions',
  bunRemote: 'tool: list_runtime_versions',
  goRemote: 'tool: list_runtime_versions',
  pythonRemote: 'tool: list_runtime_versions',
  phpRemote: 'tool: list_runtime_versions',
  // tool: list_sites, get_site, list_services, list_runtimes
  getState: 'tool: list_sites, get_site, list_services, list_runtimes',
  // tool: list_ssh_keys
  gitSshKeys: 'tool: list_ssh_keys',
  // tool: mail_get
  mailGet: 'tool: mail_get',
  // tool: mail_list
  mailList: 'tool: mail_list',
  // tool: mail_raw
  mailRaw: 'tool: mail_raw',
  // tool: monitor_history
  monitorHistory: 'tool: monitor_history',
  // tool: monitor_snapshot
  monitorSnapshot: 'tool: monitor_snapshot',
  // tool: openapi_add_generator
  addOpenApi: 'tool: openapi_add_generator',
  // tool: openapi_create
  createOpenApi: 'tool: openapi_create',
  // tool: openapi_gitignore
  openapiIgnore: 'tool: openapi_gitignore',
  openapiUnignore: 'tool: openapi_gitignore',
  openapiUntrack: 'tool: openapi_gitignore',
  // tool: php_extensions
  phpExtensions: 'tool: php_extensions',
  // tool: php_ini
  phpGetIni: 'tool: php_ini',
  // tool: restart_site
  restart: 'tool: restart_site',
  // tool: rust_status
  rustRemote: 'tool: rust_status',
  // tool: search_backups
  searchBackups: 'tool: search_backups',
  // tool: search_indexes
  searchIndexes: 'tool: search_indexes',
  // tool: search_keys
  searchKeys: 'tool: search_keys',
  // tool: search_query
  searchQuery: 'tool: search_query',
  // tool: search_settings
  searchGetSettings: 'tool: search_settings',
  // tool: search_tasks
  searchTasks: 'tool: search_tasks',
  // tool: site_build_targets
  buildTargets: 'tool: site_build_targets',
  // tool: site_dep_commands
  depCommands: 'tool: site_dep_commands',
  // tool: site_deps
  siteDeps: 'tool: site_deps',
  // tool: site_docker_env
  dockerDocatzEnv: 'tool: site_docker_env',
  dockerComposeEnv: 'tool: site_docker_env',
  // tool: site_docker_files
  dockerFiles: 'tool: site_docker_files',
  // tool: site_docker_generate
  dockerGenerate: 'tool: site_docker_generate',
  // tool: site_docker_list_files
  dockerListFiles: 'tool: site_docker_list_files',
  // tool: site_docker_preview
  dockerDevPreview: 'tool: site_docker_preview',
  // tool: site_docker_read
  dockerReadFile: 'tool: site_docker_read',
  // tool: site_docker_services
  dockerServices: 'tool: site_docker_services',
  // tool: site_env_names
  envFiles: 'tool: site_env_names',
  // tool: site_env_values
  envRead: 'tool: site_env_values',
  // tool: site_free_port
  freePortFor: 'tool: site_free_port',
  // tool: site_git_branches
  gitBranches: 'tool: site_git_branches',
  // tool: site_git_diff
  gitDiff: 'tool: site_git_diff',
  // tool: site_git_log
  gitLog: 'tool: site_git_log',
  // tool: site_git_pulls
  gitPulls: 'tool: site_git_pulls',
  // tool: site_git_show
  gitShow: 'tool: site_git_show',
  // tool: site_git_stashes
  gitStashes: 'tool: site_git_stashes',
  // tool: site_git_status
  gitStatus: 'tool: site_git_status',
  // tool: site_git_tags
  gitTags: 'tool: site_git_tags',
  // tool: site_gitignore
  gitignoreRead: 'tool: site_gitignore',
  // tool: site_gitignore_suggestions
  gitIgnoreSuggestions: 'tool: site_gitignore_suggestions',
  // tool: site_go_db
  goDbInfo: 'tool: site_go_db',
  // tool: site_laravel_log
  laravelLog: 'tool: site_laravel_log',
  // tool: site_logs
  getLogs: 'tool: site_logs',
  // tool: site_openapi
  siteOpenApi: 'tool: site_openapi',
  // tool: site_port_env
  appPortEnv: 'tool: site_port_env',
  // tool: site_port_use
  sitePortUse: 'tool: site_port_use',
  // tool: site_redis
  redisDetails: 'tool: site_redis',
  // tool: site_runtime_needs
  siteRuntimeNeeds: 'tool: site_runtime_needs',
  // tool: site_service_env
  mailEnv: 'tool: site_service_env',
  gwEnv: 'tool: site_service_env',
  waEnv: 'tool: site_service_env',
  searchEnv: 'tool: site_service_env',
  storageEnv: 'tool: site_service_env',
  wsEnv: 'tool: site_service_env',
  reverbEnv: 'tool: site_service_env',
  // tool: site_worktrees
  worktreeList: 'tool: site_worktrees',
  worktreeCheck: 'tool: site_worktrees',
  // tool: sms_list
  gwSms: 'tool: sms_list',
  // tool: start/stop/restart_service
  dbAction: 'tool: start/stop/restart_service',
  searchAction: 'tool: start/stop/restart_service',
  mailAction: 'tool: start/stop/restart_service',
  waAction: 'tool: start/stop/restart_service',
  gwAction: 'tool: start/stop/restart_service',
  wsAction: 'tool: start/stop/restart_service',
  storageAction: 'tool: start/stop/restart_service',
  // tool: start_docker_engine
  startEngine: 'tool: start_docker_engine',
  // tool: start_site
  start: 'tool: start_site',
  // tool: stop_site
  stop: 'tool: stop_site',
  // tool: storage_buckets
  s3Buckets: 'tool: storage_buckets',
  // tool: storage_list
  s3List: 'tool: storage_list',
  // tool: websocket_stats
  wsStats: 'tool: websocket_stats',
  // tool: whatsapp_contacts
  waContacts: 'tool: whatsapp_contacts',
  // tool: whatsapp_deliveries
  waDeliveries: 'tool: whatsapp_deliveries',
  // tool: whatsapp_groups
  waGroups: 'tool: whatsapp_groups',
  // tool: whatsapp_hooks
  waHooks: 'tool: whatsapp_hooks',
  // tool: whatsapp_messages
  waMessages: 'tool: whatsapp_messages',
  // tool: worktree_add
  worktreeAdd: 'tool: worktree_add',
  // tool: worktree_create
  worktreeCreate: 'tool: worktree_create',
  // later: change
  clearLogs: 'later: change',
  linkProject: 'later: change',
  parkFolder: 'later: change',
  parkRestore: 'later: change',
  missingLocate: 'later: change',
  missingLocateApply: 'later: change',
  updateProject: 'later: change',
  envKeyGenerate: 'later: change',
  dbImportOne: 'later: change',
  buildSite: 'later: change',
  setAppSubdomain: 'later: change',
  restartApp: 'later: change',
  setSitePort: 'later: change',
  envWrite: 'later: change',
  envCreate: 'later: change',
  envMerge: 'later: change',
  rescan: 'later: change',
  refreshRuntimes: 'later: change',
  db: 'later: change',
  startAll: 'later: change',
  stopAll: 'later: change',
  redisWriteEnv: 'later: change',
  installDeps: 'later: change',
  depRun: 'later: change',
  nodeSetDefault: 'later: change',
  bunSetDefault: 'later: change',
  goSetDefault: 'later: change',
  rustInstall: 'later: change',
  rustToolchainInstall: 'later: change',
  rustSetDefault: 'later: change',
  rustTargetAdd: 'later: change',
  rustToolInstall: 'later: change',
  rustInstallLinker: 'later: change',
  repairElectron: 'later: change',
  uvInstall: 'later: change',
  pythonSetDefault: 'later: change',
  phpSetDefault: 'later: change',
  phpSetIni: 'later: change',
  composerInstall: 'later: change',
  phpExtInstall: 'later: change',
  phpExtSetEnabled: 'later: change',
  restartServices: 'later: change',
  runtimeUpdate: 'later: change',
  goDbTask: 'later: change',
  stackTask: 'later: change',
  dbUpdate: 'later: change',
  dbBuildAction: 'later: change',
  searchUpdate: 'later: change',
  searchCreateIndex: 'later: change',
  searchSaveSettings: 'later: change',
  searchUpsert: 'later: change',
  searchImportFile: 'later: change',
  mailMarkRead: 'later: change',
  mailSaveAttachment: 'later: change',
  mailForward: 'later: change',
  mailSendTest: 'later: change',
  exposeInstall: 'later: change',
  exposeCancelInstall: 'later: change',
  exposeStart: 'later: change',
  exposeStop: 'later: change',
  exposeReplay: 'later: change',
  waUpdate: 'later: change',
  gwUpdate: 'later: change',
  gwSetAutoStart: 'later: change',
  gwSend: 'later: change',
  waSessionStart: 'later: change',
  waSessionLogout: 'later: change',
  waSend: 'later: change',
  waSetHook: 'later: change',
  waReplay: 'later: change',
  wsUpgrade: 'later: change',
  serviceSetAutoStart: 'later: change',
  searchCancelTasks: 'later: change',
  searchCreateBackup: 'later: change',
  searchRestoreBackup: 'later: change',
  searchCreateKey: 'later: change',
  wsUpdate: 'later: change',
  wsPublish: 'later: change',
  laravelBroadcast: 'later: change',
  laravelTestBroadcast: 'later: change',
  storageUpdate: 'later: change',
  s3CreateBucket: 'later: change',
  s3SetPublic: 'later: change',
  s3Upload: 'later: change',
  s3CancelUpload: 'later: change',
  s3Download: 'later: change',
  s3MkDir: 'later: change',
  setFavorite: 'later: change',
  setSiteGroup: 'later: change',
  renameGroup: 'later: change',
  dbSetFavorite: 'later: change',
  dbSetGroup: 'later: change',
  dbGroupAction: 'later: change',
  exposeUpgrade: 'later: change',
  gwUpgrade: 'later: change',
  waUpgrade: 'later: change',
  searchUpgrade: 'later: change',
  storageUpgrade: 'later: change',
  inspectFolder: 'later: change',
  dbImportList: 'later: change',
  rustToolsCheck: 'later: change',
  checkUpdates: 'later: change',
  exposeCheckUpdates: 'later: change',
  waCheckUpdates: 'later: change',
  gwCheckUpdates: 'later: change',
  servicesCheckUpdates: 'later: change',
  searchExport: 'later: change',
  scoutCommand: 'later: change',
  setLaunchAtLogin: 'later: change',
  shimPathSet: 'later: change',
  setTld: 'later: change',
  restartDns: 'later: change',
  // later: destructive
  unparkFolder: 'later: destructive',
  missingRemove: 'later: destructive',
  removeProject: 'later: destructive',
  openapiRemoveFile: 'later: destructive',
  openapiRemoveGenerator: 'later: destructive',
  freeDeps: 'later: destructive',
  nodeUninstall: 'later: destructive',
  bunUninstall: 'later: destructive',
  goUninstall: 'later: destructive',
  rustToolchainUninstall: 'later: destructive',
  rustToolUninstall: 'later: destructive',
  toolUninstall: 'later: destructive',
  pythonUninstall: 'later: destructive',
  phpUninstall: 'later: destructive',
  phpExtRemove: 'later: destructive',
  dbRemove: 'later: destructive',
  searchUninstall: 'later: destructive',
  searchDeleteIndex: 'later: destructive',
  searchDeleteDoc: 'later: destructive',
  mailDelete: 'later: destructive',
  mailDeleteAll: 'later: destructive',
  exposeUninstall: 'later: destructive',
  exposeClearRequests: 'later: destructive',
  waUninstall: 'later: destructive',
  gwUninstall: 'later: destructive',
  gwClearSms: 'later: destructive',
  waSessionRemove: 'later: destructive',
  waClearMessages: 'later: destructive',
  waRemoveHook: 'later: destructive',
  gitDiscard: 'later: destructive',
  worktreeRemove: 'later: destructive',
  worktreePrune: 'later: destructive',
  gitSquash: 'later: destructive',
  gitRevert: 'later: destructive',
  gitReset: 'later: destructive',
  gitRestoreFile: 'later: destructive',
  searchClearTasks: 'later: destructive',
  searchDeleteBackup: 'later: destructive',
  searchDeleteKey: 'later: destructive',
  wsUninstall: 'later: destructive',
  storageUninstall: 'later: destructive',
  s3DeleteBucket: 'later: destructive',
  s3Delete: 'later: destructive',
  deleteGroup: 'later: destructive',
  // never: a QR logs in a WhatsApp account
  waSessionQr: 'never: a QR logs in a WhatsApp account',
  // never: credentials (user, 2026-11-04)
  mailSetForwardConfig: 'never: credentials (user, 2026-11-04)',
  exposeCloudflareLogin: 'never: credentials (user, 2026-11-04)',
  exposeCloudflareLogout: 'never: credentials (user, 2026-11-04)',
  exposeSetAccount: 'never: credentials (user, 2026-11-04)',
  aiSetKey: 'never: credentials (user, 2026-11-04)',
  gitSetIdentity: 'never: credentials (user, 2026-11-04)',
  gitAddAccount: 'never: credentials (user, 2026-11-04)',
  gitRemoveAccount: 'never: credentials (user, 2026-11-04)',
  gitSshGenerate: 'never: credentials (user, 2026-11-04)',
  gitSshAddToAccount: 'never: credentials (user, 2026-11-04)',
  // never: signs with the server secret
  wsClientAuth: 'never: signs with the server secret',
  // never: system security, needs an administrator (user, 2026-11-04)
  trustCa: 'never: system security, needs an administrator (user, 2026-11-04)',
  untrustCa: 'never: system security, needs an administrator (user, 2026-11-04)',
  installResolver: 'never: system security, needs an administrator (user, 2026-11-04)',
  uninstallResolver: 'never: system security, needs an administrator (user, 2026-11-04)',
  installCleanUrls: 'never: system security, needs an administrator (user, 2026-11-04)',
  uninstallCleanUrls: 'never: system security, needs an administrator (user, 2026-11-04)',
  // never: the app itself (user, 2026-11-04)
  uninstallPlan: 'never: the app itself (user, 2026-11-04)',
  uninstall: 'never: the app itself (user, 2026-11-04)',
  updateSettings: 'never: the app itself (user, 2026-11-04)',
  // not a tool
  runtimePick: 'not a tool',
  mailAttachmentData: 'not a tool',
  pickFolder: 'not a tool',
  aboutInfo: 'not a tool',
  appUpdateCheck: 'not a tool',
  appUpdateDownload: 'not a tool',
  appUpdateCancel: 'not a tool',
  appUpdateRestart: 'not a tool',
  appUpdateSkip: 'not a tool',
  appUpdateInstallOnQuit: 'not a tool',
  appUpdatePrefs: 'not a tool',
  reportPreview: 'not a tool',
  reportSend: 'not a tool',
  captureWindow: 'not a tool',
  reportError: 'not a tool',
  setCrashReports: 'not a tool',
  crashAskDismiss: 'not a tool',
  openapiReveal: 'not a tool',
  mcatzpAnswer: 'not a tool',
  mcatzpActivity: 'not a tool',
  mcatzpClearActivity: 'not a tool',
  mcatzpRevoke: 'not a tool',
  dialcatzOpen: 'not a tool',
  dialcatzInstall: 'not a tool',
  dialcatzCancelInstall: 'not a tool',
  dialcatzDismiss: 'not a tool',
  docatzOpen: 'not a tool',
  docatzOpenGateway: 'not a tool',
  docatzInstallGateway: 'not a tool',
  docatzInstall: 'not a tool',
  docatzCancelInstall: 'not a tool',
  docatzDismiss: 'not a tool',
  openUrl: 'not a tool',
  openFolder: 'not a tool',
  openEditor: 'not a tool',
  openTerminal: 'not a tool',
  revealCa: 'not a tool',
  quitApp: 'not a tool',
  takePendingNav: 'not a tool',
  getScreenshot: 'not a tool',
  refreshScreenshot: 'not a tool',
  phpExtDismiss: 'not a tool',
  phpOpenIni: 'not a tool',
  dbDismiss: 'not a tool',
  dbOpenData: 'not a tool',
  dbOpenBinaries: 'not a tool',
  dbcatzOpen: 'not a tool',
  dbcatzInstall: 'not a tool',
  dbcatzCancelInstall: 'not a tool',
  dbcatzDismiss: 'not a tool',
  monitorLive: 'not a tool',
  monitorExport: 'not a tool',
  searchOpenData: 'not a tool',
  mailOpenData: 'not a tool',
  waOpenData: 'not a tool',
  taskDismiss: 'not a tool',
  gwOpenData: 'not a tool',
  aiSettings: 'not a tool',
  aiSetSettings: 'not a tool',
  aiModels: 'not a tool',
  aiProbe: 'not a tool',
  aiTest: 'not a tool',
  aiCancel: 'not a tool',
  aiPreviewExplain: 'not a tool',
  aiExplain: 'not a tool',
  aiPreviewCommit: 'not a tool',
  aiCommit: 'not a tool',
  aiPreviewDockerEdit: 'not a tool',
  aiDockerEdit: 'not a tool',
  aiPreviewEnv: 'not a tool',
  aiEnv: 'not a tool',
  aiPreviewSearch: 'not a tool',
  aiSearch: 'not a tool',
  aiPreviewWebhook: 'not a tool',
  aiWebhook: 'not a tool',
  aiPreviewAsk: 'not a tool',
  aiAsk: 'not a tool',
  aiRunAction: 'not a tool',
  gitOpenFile: 'not a tool',
  searchRevealBackup: 'not a tool',
  wsOpenData: 'not a tool',
  storageOpenData: 'not a tool',
  openLogsFolder: 'not a tool',
  pickFile: 'not a tool',
  toggleGroup: 'not a tool',
  moveGroup: 'not a tool',
  siteMenu: 'not a tool',
  groupMenu: 'not a tool',
  setSiteOrder: 'not a tool',
  dbSetOrder: 'not a tool',
  dbMenu: 'not a tool',
  dbGroupMenu: 'not a tool',
} satisfies Record<keyof HerdApi, string>;
