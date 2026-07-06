; Juggler Windows installer (Inno Setup).
;
; Ships the two binaries as ONE indivisible unit in one directory, upholding the
; invariant in docs/distribution.md: the desktop app (juggler-app.exe) locates
; its server (juggler.exe) as a sibling, so a single install dir guarantees the
; app always spawns a server of its exact build. Never install them separately.
;
; Build (from the repo root, after `make build-windows`):
;   iscc /DMyAppVersion=v1.2.3 packaging\windows\juggler.iss
; The version is injected by CI/Make; it falls back to "dev" for a bare run.

#ifndef MyAppVersion
  #define MyAppVersion "dev"
#endif

#define MyAppName "Juggler"
#define MyAppPublisher "Julian Storer"
#define MyAppExeName "juggler-app.exe"
#define MyAppCliName "juggler.exe"

[Setup]
; AppId is the stable upgrade key — keep this GUID constant across releases so
; new versions upgrade in place rather than installing side by side.
AppId={{B7E6A1C2-3D4F-4A5B-9C8D-2E1F0A9B8C7D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\Juggler
DefaultGroupName=Juggler
DisableProgramGroupPage=yes
; Per-user install, no UAC elevation. With PrivilegesRequired=lowest, {autopf}
; resolves to %LocalAppData%\Programs\Juggler, which keeps it consistent with the
; HKCU PATH write below (the [Registry] line targets the per-user hive — an
; admin/all-users install would write PATH to the wrong place, so we don't offer
; that mode). Windows-on-ARM runs this x64 build under emulation, so one amd64
; installer covers every Windows user.
PrivilegesRequired=lowest
; x64compatible (NOT x64) is load-bearing: it permits installation on ARM64,
; where this amd64 build runs under x64 emulation. Plain "x64" would block ARM.
; Requires Inno Setup 6.3+ (Chocolatey ships current 6.x).
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\bin\windows
OutputBaseFilename=Juggler-{#MyAppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Tell Explorer/shells that PATH may have changed so new terminals pick it up.
ChangesEnvironment=yes
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "addtopath"; Description: "Add Juggler to PATH (run 'juggler' from any terminal)"; GroupDescription: "Command line:"
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
; The two binaries land in the same {app} dir — the load-bearing invariant.
Source: "..\..\bin\windows\{#MyAppCliName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\bin\windows\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Juggler"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall Juggler"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Juggler"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
; Append {app} to the user PATH only when the task is selected and it isn't
; already present (NeedsAddPath guards against duplicate entries on reinstall).
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}"; Tasks: addtopath; Check: NeedsAddPath('{app}')

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Juggler"; \
  Flags: nowait postinstall skipifsilent

[Code]
function NeedsAddPath(Param: string): Boolean;
var
  OrigPath: string;
  AppDir: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  AppDir := ExpandConstant(Param);
  { Pad both sides with ';' so we match a full segment, not a substring. }
  Result := Pos(';' + Uppercase(AppDir) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;
