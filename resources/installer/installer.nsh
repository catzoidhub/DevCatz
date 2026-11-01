; DevCatz's additions to electron-builder's assisted NSIS installer (electron-builder.yml nsis.include).
; Pages: Welcome → Only me / Anyone → folder → Shortcuts → install → Finish.
; The desktop shortcut is DevCatz's own (createDesktopShortcut: false) so the installer can ask: an update (--updated)
; leaves it as the user left it, uninstall removes it.
; The Start menu entry is always made (Windows search finds the app through it). Pinning to the taskbar is the user's:
; Windows offers no supported way for an installer to do it.

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
  Var scDesktop
  Var scDesktopBox

  !macro customWelcomePage
    !define MUI_WELCOMEPAGE_TITLE "Welcome to DevCatz"
    !define MUI_WELCOMEPAGE_TEXT "Your projects on their own names, like https://shop.localhost, with the right runtime, a database a click away, and mail, storage and search when they need them.$\r$\n$\r$\nDevCatz installs for your account only: no administrator rights needed, and nothing changes outside its own folders until you choose it inside the app.$\r$\n$\r$\nClick Next to continue."
    !insertmacro skipPageIfUpdated
    !insertmacro MUI_PAGE_WELCOME

    ; The Finish page (inserted later by electron-builder) reads these.
    !define MUI_FINISHPAGE_TITLE "DevCatz is ready"
    !define MUI_FINISHPAGE_TEXT "Open it from the Start menu, or from the desktop shortcut if you chose one.$\r$\n$\r$\nTip: to keep it on the taskbar, right-click DevCatz in Start and choose Pin to taskbar."
    !define MUI_FINISHPAGE_RUN_TEXT "Open DevCatz now"
  !macroend

  ; The page's functions live in the macro: it is expanded after electron-builder's helpers (isUpdated) exist.
  !macro customPageAfterChangeDir
    Page custom scPageCreate scPageLeave

    Function scPageCreate
      ${if} ${isUpdated}
        Abort
      ${endif}
      !insertmacro MUI_HEADER_TEXT "Shortcuts" "Where you want to open DevCatz from."
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateLabel} 0 0 100% 20u "DevCatz is always added to the Start menu, so Windows search finds it."
      Pop $0
      ${NSD_CreateCheckbox} 0 26u 100% 12u "Create a &desktop shortcut"
      Pop $scDesktopBox
      ${if} $scDesktop != "0"
        ${NSD_Check} $scDesktopBox
      ${endif}
      ${NSD_CreateLabel} 0 52u 100% 30u "Taskbar: Windows lets only you pin apps there. After installing, right-click DevCatz in Start (or its window's taskbar button) and choose Pin to taskbar."
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function scPageLeave
      ${NSD_GetState} $scDesktopBox $0
      ${if} $0 == ${BST_CHECKED}
        StrCpy $scDesktop "1"
      ${else}
        StrCpy $scDesktop "0"
      ${endif}
    FunctionEnd
  !macroend

  !macro customInstall
    ; An update keeps whatever the user did with the shortcut since.
    ${ifNot} ${isUpdated}
      ${if} $scDesktop == "0"
        WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
        Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
      ${else}
        ; Also a silent install (/S), which shows no pages: the shortcut, as before.
        CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
      ${endif}
    ${endif}
  !macroend
!else
  !macro customUnInstall
    ${ifNot} ${isUpdated}
      WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    ${endif}
  !macroend
!endif
