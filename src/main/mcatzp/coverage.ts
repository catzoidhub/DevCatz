import type { HerdApi } from '@shared/types';

/**
 * Every action DevCatz can do, and where it stands with MCatzP (scope: every action, user 2026-10-28). A new method in
 * HerdApi fails the typecheck here until it is placed, so nothing is left out unnoticed.
 * `tool: …` is done. `later: …` is still to do, in that tier. `not a tool`: it only makes sense in the window (a menu, a
 * file picker, this app's own updater or AI buttons). `never: …`: left out on purpose, with why.
 */
export const MCATZP_COVERAGE = {
  // tool: arrange_db_list
  dbSetOrder: 'tool: arrange_db_list',
  // tool: arrange_site_list
  toggleGroup: 'tool: arrange_site_list',
  moveGroup: 'tool: arrange_site_list',
  setSiteOrder: 'tool: arrange_site_list',
  // tool: build_site
  buildSite: 'tool: build_site',
  // tool: cancel_install
  installCancel: 'tool: cancel_install',
  dbCancelCreate: 'tool: cancel_install',
  searchCancelInstall: 'tool: cancel_install',
  waCancelInstall: 'tool: cancel_install',
  gwCancelInstall: 'tool: cancel_install',
  wsCancelInstall: 'tool: cancel_install',
  storageCancelInstall: 'tool: cancel_install',
  // tool: check_app_update
  appUpdateCheck: 'tool: check_app_update',
  // tool: check_updates
  rustToolsCheck: 'tool: check_updates',
  checkUpdates: 'tool: check_updates',
  exposeCheckUpdates: 'tool: check_updates',
  waCheckUpdates: 'tool: check_updates',
  gwCheckUpdates: 'tool: check_updates',
  servicesCheckUpdates: 'tool: check_updates',
  // tool: clear_caught
  exposeClearRequests: 'tool: clear_caught',
  gwClearSms: 'tool: clear_caught',
  waClearMessages: 'tool: clear_caught',
  // tool: clear_site_logs
  clearLogs: 'tool: clear_site_logs',
  // tool: create_database
  dbCreateDatabase: 'tool: create_database',
  // tool: create_service
  dbDefaults: 'tool: create_service',
  dbCreate: 'tool: create_service',
  // tool: delete_site_group
  deleteGroup: 'tool: delete_site_group',
  // tool: deps_report
  depsReport: 'tool: deps_report',
  // tool: dismiss_notice
  dialcatzDismiss: 'tool: dismiss_notice',
  docatzDismiss: 'tool: dismiss_notice',
  phpExtDismiss: 'tool: dismiss_notice',
  dbDismiss: 'tool: dismiss_notice',
  dbcatzDismiss: 'tool: dismiss_notice',
  taskDismiss: 'tool: dismiss_notice',
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
  // tool: env_create
  envCreate: 'tool: env_create',
  // tool: env_generate_key
  envKeyGenerate: 'tool: env_generate_key',
  // tool: env_remove_variable (whole-file edits: the Env tab)
  envWrite: 'tool: env_remove_variable (whole-file edits: the Env tab)',
  // tool: env_write
  envMerge: 'tool: env_write',
  // tool: expose_cancel_install
  exposeCancelInstall: 'tool: expose_cancel_install',
  // tool: expose_install
  exposeInstall: 'tool: expose_install',
  exposeUpgrade: 'tool: expose_install',
  // tool: expose_replay
  exposeReplay: 'tool: expose_replay',
  // tool: expose_requests
  exposeRequests: 'tool: expose_requests',
  // tool: forget_missing_site
  missingRemove: 'tool: forget_missing_site',
  // tool: free_site_deps
  freeDeps: 'tool: free_site_deps',
  // tool: gateway_send
  gwSend: 'tool: gateway_send',
  // tool: get_status
  mailForwardConfig: 'tool: get_status',
  // tool: git_add_remote
  gitAddRemote: 'tool: git_add_remote',
  // tool: git_branch (delete: git_branch_delete / git_tag_delete)
  gitBranch: 'tool: git_branch (delete: git_branch_delete / git_tag_delete)',
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
  // tool: git_commit (amend: git_amend)
  gitCommit: 'tool: git_commit (amend: git_amend)',
  // tool: git_create_pull
  gitCreatePull: 'tool: git_create_pull',
  // tool: git_discard
  gitDiscard: 'tool: git_discard',
  // tool: git_ignore_add
  gitIgnoreAdd: 'tool: git_ignore_add',
  // tool: git_ignore_save
  gitignoreSave: 'tool: git_ignore_save',
  // tool: git_init
  gitInit: 'tool: git_init',
  // tool: git_rebase
  gitOperation: 'tool: git_rebase',
  // tool: git_reset
  gitReset: 'tool: git_reset',
  // tool: git_restore_file
  gitRestoreFile: 'tool: git_restore_file',
  // tool: git_revert
  gitRevert: 'tool: git_revert',
  // tool: git_squash
  gitSquash: 'tool: git_squash',
  // tool: git_stage
  gitStage: 'tool: git_stage',
  // tool: git_stash (drop: git_stash_drop)
  gitStash: 'tool: git_stash (drop: git_stash_drop)',
  // tool: git_sync (force push: git_force_push)
  gitSync: 'tool: git_sync (force push: git_force_push)',
  // tool: git_tag (delete: git_branch_delete / git_tag_delete)
  gitTag: 'tool: git_tag (delete: git_branch_delete / git_tag_delete)',
  // tool: git_unstage
  gitUnstage: 'tool: git_unstage',
  // tool: import_databases
  dbImportOne: 'tool: import_databases',
  dbImportList: 'tool: import_databases',
  // tool: install_cancel_catzoid_app
  dialcatzCancelInstall: 'tool: install_cancel_catzoid_app',
  docatzCancelInstall: 'tool: install_cancel_catzoid_app',
  dbcatzCancelInstall: 'tool: install_cancel_catzoid_app',
  // tool: install_catzoid_app
  dialcatzInstall: 'tool: install_catzoid_app',
  docatzInstall: 'tool: install_catzoid_app',
  dbcatzInstall: 'tool: install_catzoid_app',
  // tool: install_composer
  composerInstall: 'tool: install_composer',
  // tool: install_deps
  installDeps: 'tool: install_deps',
  // tool: install_runtime
  nodeInstall: 'tool: install_runtime',
  bunInstall: 'tool: install_runtime',
  goInstall: 'tool: install_runtime',
  pythonInstall: 'tool: install_runtime',
  phpInstall: 'tool: install_runtime',
  // tool: install_runtime_tool
  toolInstall: 'tool: install_runtime_tool',
  // tool: install_rust
  rustInstall: 'tool: install_rust',
  // tool: install_rust_tool
  rustToolInstall: 'tool: install_rust_tool',
  rustInstallLinker: 'tool: install_rust_tool',
  // tool: install_service
  searchInstall: 'tool: install_service',
  waInstall: 'tool: install_service',
  gwInstall: 'tool: install_service',
  wsInstall: 'tool: install_service',
  storageInstall: 'tool: install_service',
  // tool: install_uv
  uvInstall: 'tool: install_uv',
  // tool: laravel_broadcast_test
  laravelTestBroadcast: 'tool: laravel_broadcast_test',
  // tool: link_site
  linkProject: 'tool: link_site',
  inspectFolder: 'tool: link_site',
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
  // tool: locate_missing_site
  missingLocateApply: 'tool: locate_missing_site',
  // tool: mail_delete
  mailDelete: 'tool: mail_delete',
  // tool: mail_delete_all
  mailDeleteAll: 'tool: mail_delete_all',
  // tool: mail_forward
  mailForward: 'tool: mail_forward',
  // tool: mail_get
  mailGet: 'tool: mail_get',
  // tool: mail_list
  mailList: 'tool: mail_list',
  // tool: mail_mark_read
  mailMarkRead: 'tool: mail_mark_read',
  // tool: mail_raw
  mailRaw: 'tool: mail_raw',
  // tool: mail_send_test
  mailSendTest: 'tool: mail_send_test',
  // tool: monitor_history
  monitorHistory: 'tool: monitor_history',
  // tool: monitor_snapshot
  monitorSnapshot: 'tool: monitor_snapshot',
  // tool: open_data_folder
  dbOpenData: 'tool: open_data_folder',
  searchOpenData: 'tool: open_data_folder',
  mailOpenData: 'tool: open_data_folder',
  waOpenData: 'tool: open_data_folder',
  gwOpenData: 'tool: open_data_folder',
  wsOpenData: 'tool: open_data_folder',
  storageOpenData: 'tool: open_data_folder',
  // tool: open_in_dbcatz
  dbcatzOpen: 'tool: open_in_dbcatz',
  // tool: open_in_dialcatz
  dialcatzOpen: 'tool: open_in_dialcatz',
  // tool: open_in_docatz
  docatzOpen: 'tool: open_in_docatz',
  docatzOpenGateway: 'tool: open_in_docatz',
  // tool: open_logs_folder
  openLogsFolder: 'tool: open_logs_folder',
  // tool: open_php_ini
  phpOpenIni: 'tool: open_php_ini',
  // tool: open_site
  openFolder: 'tool: open_site',
  openEditor: 'tool: open_site',
  openTerminal: 'tool: open_site',
  // tool: open_site_file
  openapiReveal: 'tool: open_site_file',
  gitOpenFile: 'tool: open_site_file',
  // tool: open_url, open_site
  openUrl: 'tool: open_url, open_site',
  // tool: openapi_add_generator
  addOpenApi: 'tool: openapi_add_generator',
  // tool: openapi_create
  createOpenApi: 'tool: openapi_create',
  // tool: openapi_gitignore
  openapiIgnore: 'tool: openapi_gitignore',
  openapiUnignore: 'tool: openapi_gitignore',
  openapiUntrack: 'tool: openapi_gitignore',
  // tool: openapi_remove
  openapiRemoveFile: 'tool: openapi_remove',
  openapiRemoveGenerator: 'tool: openapi_remove',
  // tool: park_folder
  parkFolder: 'tool: park_folder',
  // tool: park_restore
  parkRestore: 'tool: park_restore',
  // tool: php_extension
  phpExtInstall: 'tool: php_extension',
  phpExtSetEnabled: 'tool: php_extension',
  // tool: php_extensions
  phpExtensions: 'tool: php_extensions',
  // tool: php_ini
  phpGetIni: 'tool: php_ini',
  // tool: php_set_ini
  phpSetIni: 'tool: php_set_ini',
  // tool: redis_write_env
  redisWriteEnv: 'tool: redis_write_env',
  // tool: refresh_runtimes
  rescan: 'tool: refresh_runtimes',
  refreshRuntimes: 'tool: refresh_runtimes',
  // tool: remove_db_build
  dbBuildAction: 'tool: remove_db_build',
  // tool: remove_php_extension
  phpExtRemove: 'tool: remove_php_extension',
  // tool: remove_site
  removeProject: 'tool: remove_site',
  // tool: rename_db_group, delete_db_group
  dbGroupAction: 'tool: rename_db_group, delete_db_group',
  // tool: rename_site_group
  renameGroup: 'tool: rename_site_group',
  // tool: repair_electron
  repairElectron: 'tool: repair_electron',
  // tool: restart_app
  restartApp: 'tool: restart_app',
  // tool: restart_dns
  restartDns: 'tool: restart_dns',
  // tool: restart_php
  restartServices: 'tool: restart_php',
  // tool: restart_site
  restart: 'tool: restart_site',
  // tool: run_dep_command
  depRun: 'tool: run_dep_command',
  // tool: run_go_db_task
  goDbTask: 'tool: run_go_db_task',
  // tool: run_stack_task
  stackTask: 'tool: run_stack_task',
  // tool: rust_status
  rustRemote: 'tool: rust_status',
  // tool: rust_toolchain
  rustToolchainInstall: 'tool: rust_toolchain',
  rustSetDefault: 'tool: rust_toolchain',
  rustTargetAdd: 'tool: rust_toolchain',
  // tool: scout_command (flush: scout_flush)
  scoutCommand: 'tool: scout_command (flush: scout_flush)',
  // tool: search_add_documents
  searchUpsert: 'tool: search_add_documents',
  // tool: search_backups
  searchBackups: 'tool: search_backups',
  // tool: search_cancel_tasks
  searchCancelTasks: 'tool: search_cancel_tasks',
  // tool: search_clear_tasks
  searchClearTasks: 'tool: search_clear_tasks',
  // tool: search_create_backup
  searchCreateBackup: 'tool: search_create_backup',
  // tool: search_create_index
  searchCreateIndex: 'tool: search_create_index',
  // tool: search_create_key
  searchCreateKey: 'tool: search_create_key',
  // tool: search_delete_backup
  searchDeleteBackup: 'tool: search_delete_backup',
  // tool: search_delete_document
  searchDeleteDoc: 'tool: search_delete_document',
  // tool: search_delete_index
  searchDeleteIndex: 'tool: search_delete_index',
  // tool: search_delete_key
  searchDeleteKey: 'tool: search_delete_key',
  // tool: search_indexes
  searchIndexes: 'tool: search_indexes',
  // tool: search_keys
  searchKeys: 'tool: search_keys',
  // tool: search_query
  searchQuery: 'tool: search_query',
  // tool: search_restore_backup
  searchRestoreBackup: 'tool: search_restore_backup',
  // tool: search_save_settings
  searchSaveSettings: 'tool: search_save_settings',
  // tool: search_settings
  searchGetSettings: 'tool: search_settings',
  // tool: search_tasks
  searchTasks: 'tool: search_tasks',
  // tool: set_app_port
  setSitePort: 'tool: set_app_port',
  // tool: set_app_subdomain
  setAppSubdomain: 'tool: set_app_subdomain',
  // tool: set_db_favorite
  dbSetFavorite: 'tool: set_db_favorite',
  // tool: set_db_group
  dbSetGroup: 'tool: set_db_group',
  // tool: set_default_domain
  setTld: 'tool: set_default_domain',
  // tool: set_default_runtime
  nodeSetDefault: 'tool: set_default_runtime',
  bunSetDefault: 'tool: set_default_runtime',
  goSetDefault: 'tool: set_default_runtime',
  pythonSetDefault: 'tool: set_default_runtime',
  phpSetDefault: 'tool: set_default_runtime',
  // tool: set_launch_at_login
  setLaunchAtLogin: 'tool: set_launch_at_login',
  // tool: set_shim_path
  shimPathSet: 'tool: set_shim_path',
  // tool: set_site_favorite
  setFavorite: 'tool: set_site_favorite',
  // tool: set_site_group
  setSiteGroup: 'tool: set_site_group',
  // tool: share_site
  exposeStart: 'tool: share_site',
  // tool: site_broadcast
  laravelBroadcast: 'tool: site_broadcast',
  // tool: site_build_targets
  buildTargets: 'tool: site_build_targets',
  // tool: site_database
  db: 'tool: site_database',
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
  // tool: site_env_values, env_show_secret
  envRead: 'tool: site_env_values, env_show_secret',
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
  // tool: site_screenshot
  getScreenshot: 'tool: site_screenshot',
  refreshScreenshot: 'tool: site_screenshot',
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
  // tool: start_all_sites
  startAll: 'tool: start_all_sites',
  // tool: start_docker_engine
  startEngine: 'tool: start_docker_engine',
  // tool: start_site
  start: 'tool: start_site',
  // tool: stop_all_sites
  stopAll: 'tool: stop_all_sites',
  // tool: stop_share
  exposeStop: 'tool: stop_share',
  // tool: stop_site
  stop: 'tool: stop_site',
  // tool: storage_buckets
  s3Buckets: 'tool: storage_buckets',
  // tool: storage_cancel_upload
  s3CancelUpload: 'tool: storage_cancel_upload',
  // tool: storage_create_bucket
  s3CreateBucket: 'tool: storage_create_bucket',
  // tool: storage_delete
  s3Delete: 'tool: storage_delete',
  // tool: storage_delete_bucket
  s3DeleteBucket: 'tool: storage_delete_bucket',
  // tool: storage_list
  s3List: 'tool: storage_list',
  // tool: storage_make_folder
  s3MkDir: 'tool: storage_make_folder',
  // tool: storage_set_public
  s3SetPublic: 'tool: storage_set_public',
  // tool: storage_upload
  s3Upload: 'tool: storage_upload',
  // tool: uninstall_runtime
  nodeUninstall: 'tool: uninstall_runtime',
  bunUninstall: 'tool: uninstall_runtime',
  goUninstall: 'tool: uninstall_runtime',
  pythonUninstall: 'tool: uninstall_runtime',
  phpUninstall: 'tool: uninstall_runtime',
  // tool: uninstall_runtime_tool
  toolUninstall: 'tool: uninstall_runtime_tool',
  // tool: uninstall_rust_part
  rustToolchainUninstall: 'tool: uninstall_rust_part',
  rustToolUninstall: 'tool: uninstall_rust_part',
  // tool: uninstall_service
  dbRemove: 'tool: uninstall_service',
  searchUninstall: 'tool: uninstall_service',
  waUninstall: 'tool: uninstall_service',
  gwUninstall: 'tool: uninstall_service',
  wsUninstall: 'tool: uninstall_service',
  storageUninstall: 'tool: uninstall_service',
  // tool: uninstall_tunnel_tool
  exposeUninstall: 'tool: uninstall_tunnel_tool',
  // tool: unpark_folder
  unparkFolder: 'tool: unpark_folder',
  // tool: update_runtime
  runtimeUpdate: 'tool: update_runtime',
  // tool: update_service
  dbUpdate: 'tool: update_service',
  searchUpdate: 'tool: update_service',
  waUpdate: 'tool: update_service',
  gwUpdate: 'tool: update_service',
  gwSetAutoStart: 'tool: update_service',
  serviceSetAutoStart: 'tool: update_service',
  wsUpdate: 'tool: update_service',
  storageUpdate: 'tool: update_service',
  // tool: update_site
  updateProject: 'tool: update_site',
  // tool: upgrade_service
  wsUpgrade: 'tool: upgrade_service',
  gwUpgrade: 'tool: upgrade_service',
  waUpgrade: 'tool: upgrade_service',
  searchUpgrade: 'tool: upgrade_service',
  storageUpgrade: 'tool: upgrade_service',
  // tool: websocket_publish
  wsPublish: 'tool: websocket_publish',
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
  // tool: whatsapp_remove_hook
  waRemoveHook: 'tool: whatsapp_remove_hook',
  // tool: whatsapp_remove_session
  waSessionRemove: 'tool: whatsapp_remove_session',
  // tool: whatsapp_replay
  waReplay: 'tool: whatsapp_replay',
  // tool: whatsapp_send
  waSend: 'tool: whatsapp_send',
  // tool: whatsapp_session
  waSessionStart: 'tool: whatsapp_session',
  waSessionLogout: 'tool: whatsapp_session',
  // tool: whatsapp_set_hook
  waSetHook: 'tool: whatsapp_set_hook',
  // tool: worktree_add
  worktreeAdd: 'tool: worktree_add',
  // tool: worktree_create
  worktreeCreate: 'tool: worktree_create',
  // tool: worktree_prune
  worktreePrune: 'tool: worktree_prune',
  // tool: worktree_remove
  worktreeRemove: 'tool: worktree_remove',
  // never: a QR logs in a WhatsApp account
  waSessionQr: 'never: a QR logs in a WhatsApp account',
  // never: a client must not answer its own questions or clear its trail
  mcatzpAnswer: 'never: a client must not answer its own questions or clear its trail',
  mcatzpActivity: 'never: a client must not answer its own questions or clear its trail',
  mcatzpClearActivity: 'never: a client must not answer its own questions or clear its trail',
  mcatzpRevoke: 'never: a client must not answer its own questions or clear its trail',
  // never: what runs a client on this computer is the user's to install
  mcatzpSetup: "never: what runs a client on this computer is the user's to install",
  mcatzpInstall: "never: what runs a client on this computer is the user's to install",
  mcatzpInstallCancel: "never: what runs a client on this computer is the user's to install",
  mcatzpApprovals: "never: what runs a client on this computer is the user's to install",
  mcatzpTargets: "never: what runs a client on this computer is the user's to install",
  mcatzpAddToClient: "never: what runs a client on this computer is the user's to install",
  mcatzpRemoveFromClient: "never: what runs a client on this computer is the user's to install",
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
  // never: reports go out in the users name
  reportPreview: 'never: reports go out in the users name',
  reportSend: 'never: reports go out in the users name',
  reportError: 'never: reports go out in the users name',
  setCrashReports: 'never: reports go out in the users name',
  crashAskDismiss: 'never: reports go out in the users name',
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
  // never: updating the app itself stays with the user
  appUpdateDownload: 'never: updating the app itself stays with the user',
  appUpdateCancel: 'never: updating the app itself stays with the user',
  appUpdateRestart: 'never: updating the app itself stays with the user',
  appUpdateSkip: 'never: updating the app itself stays with the user',
  appUpdateInstallOnQuit: 'never: updating the app itself stays with the user',
  appUpdatePrefs: 'never: updating the app itself stays with the user',
  // not a tool
  searchImportFile: 'not a tool',
  mailSaveAttachment: 'not a tool',
  s3Download: 'not a tool',
  searchExport: 'not a tool',
  missingLocate: 'not a tool',
  runtimePick: 'not a tool',
  mailAttachmentData: 'not a tool',
  pickFolder: 'not a tool',
  aboutInfo: 'not a tool',
  captureWindow: 'not a tool',
  docatzInstallGateway: 'not a tool',
  revealCa: 'not a tool',
  quitApp: 'not a tool',
  takePendingNav: 'not a tool',
  dbOpenBinaries: 'not a tool',
  monitorLive: 'not a tool',
  monitorExport: 'not a tool',
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
  searchRevealBackup: 'not a tool',
  pickFile: 'not a tool',
  siteMenu: 'not a tool',
  groupMenu: 'not a tool',
  dbMenu: 'not a tool',
  dbGroupMenu: 'not a tool',
} satisfies Record<keyof HerdApi, string>;
