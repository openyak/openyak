; Custom NSIS installer hooks for OpenYak.
;
; OpenYak runs as two processes: the Tauri UI (OpenYak.exe) and a PyInstaller
; sidecar (openyak-backend.exe). The backend keeps several .pyd files loaded
; (e.g. PIL's _imaging.pyd, mypyc-compiled modules), which locks them on disk.
;
; Tauri's default NSIS template only terminates ${MAINBINARYNAME}.exe before
; writing files, so if the backend is still running the installer fails with
; "Error opening file for writing: ...\backend\_internal\*.pyd".
;
; This hook runs before file extraction and force-kills the backend sidecar
; (and any leftover main binary instances) so the install can overwrite
; locked files cleanly.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Terminating OpenYak backend process if running..."

  ; Kill the backend sidecar. Try current-user first (matches our default
  ; per-user install), then fall back to the machine-wide variant so this
  ; also works when the installer is running elevated.
  nsis_tauri_utils::FindProcessCurrentUser "openyak-backend.exe"
  Pop $R0
  ${If} $R0 = 0
    nsis_tauri_utils::KillProcessCurrentUser "openyak-backend.exe"
    Pop $R0
  ${EndIf}

  nsis_tauri_utils::FindProcess "openyak-backend.exe"
  Pop $R0
  ${If} $R0 = 0
    nsis_tauri_utils::KillProcess "openyak-backend.exe"
    Pop $R0
  ${EndIf}

  ; Also make sure the main binary is gone. Tauri's CheckIfAppIsRunning
  ; handles this later too, but doing it here means we don't race the
  ; backend respawning a UI process between the two steps.
  nsis_tauri_utils::FindProcessCurrentUser "OpenYak.exe"
  Pop $R0
  ${If} $R0 = 0
    nsis_tauri_utils::KillProcessCurrentUser "OpenYak.exe"
    Pop $R0
  ${EndIf}

  ; Give Windows a moment to release the file handles the killed
  ; processes were holding before we start overwriting files.
  Sleep 1000

  ; Remove the previous backend payload outright rather than extracting over
  ; it. NSIS only overwrites the files it is installing, so anything a former
  ; version shipped and this one does not stays on disk forever.
  ;
  ; That is not merely untidy. _internal is on the frozen interpreter's
  ; sys.path, so an orphaned directory there can shadow a module name: a
  ; stale "freetype" folder left by an older build made "import freetype"
  ; resolve to an empty namespace package, and reportlab -- which probes for
  ; freetype-py and only guards against ImportError -- then died on
  ; AttributeError during startup. The backend never came up, so the whole
  ; app was dead after upgrading while a clean install worked fine.
  ;
  ; Only application payload lives here; user data is under AppData.
  ${If} ${FileExists} "$INSTDIR\backend\*.*"
    DetailPrint "Removing previous backend payload..."
    RMDir /r "$INSTDIR\backend"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\nodejs\*.*"
    DetailPrint "Removing previous Node.js runtime..."
    RMDir /r "$INSTDIR\nodejs"
  ${EndIf}
!macroend

; Uninstalling left 179 files behind, which is how the stale payload above
; survives a reinstall as well as an upgrade. Remove the bundled runtimes
; explicitly; user data under AppData is deliberately untouched.
!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "Removing bundled runtimes..."
  RMDir /r "$INSTDIR\backend"
  RMDir /r "$INSTDIR\nodejs"
  RMDir "$INSTDIR"
!macroend
