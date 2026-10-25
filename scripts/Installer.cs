using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Windows.Forms;

// A per-user bootstrapper. No elevation, registry policy, or Chrome profile edits.
class OnSoriSetup : Form {
    string root;
    bool busy;
    Label status = new Label();
    Label intro = new Label();
    ProgressBar progress = new ProgressBar();
    TextBox log = new TextBox();
    Button install = new Button();
    Button chrome = new Button();
    Button watch = new Button();
    CheckBox startup = new CheckBox();
    readonly object logLock = new object();

    [STAThread]
    static int Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string appRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OnSori");
        if (args.Length > 0 && args[0] == "--guide") {
            using (var guide = new OnSoriSetup(Path.GetDirectoryName(Application.ExecutablePath))) {
                if (File.Exists(Path.Combine(guide.root, "runtime/installation.json"))) guide.ShowReady();
                Application.Run(guide);
            }
            return 0;
        }
        if (args.Length > 0 && (args[0] == "--launch" || args[0] == "--background")) {
            appRoot = Path.GetDirectoryName(Application.ExecutablePath);
            try {
                using (var host = new OnSoriSetup(appRoot)) {
                    int result = host.RunScript("start.ps1", "-NoBrowser");
                    if (result != 0) throw new Exception("서버를 시작하지 못했습니다. 온소리 설치 파일을 다시 실행하거나 runtime/server-error.log를 확인해 주세요.");
                    if (args[0] == "--launch") OpenChrome("https://www.youtube.com/");
                }
                return 0;
            } catch (Exception ex) { MessageBox.Show(ex.Message, "온소리 시작 안내"); return 1; }
        }
        // Non-interactive QA uses a fresh explicit root, without shortcuts or browser changes.
        if (args.Length == 2 && args[0] == "--install-test") {
            using (var form = new OnSoriSetup(Path.GetFullPath(args[1]))) {
                try { form.Extract(); return form.RunScript("install-runtime.ps1", "-NoShortcuts"); }
                catch (Exception ex) { form.Record(ex.ToString()); return 1; }
            }
        }
        Application.Run(new OnSoriSetup(appRoot));
        return 0;
    }

    OnSoriSetup(string directory) {
        root = directory;
        Text = "온소리 · 간편 설치";
        ClientSize = new Size(700, 650);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Malgun Gothic", 10);
        BackColor = Color.FromArgb(247, 249, 252);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        var title = new Label { Text = "소리를 읽는 새로운 방법, 온소리", Font = new Font("Malgun Gothic", 21, FontStyle.Bold), AutoSize = false, Bounds = new Rectangle(28, 25, 650, 48) };
        intro.Text = "설치 버튼 한 번으로 분석 프로그램과 AI 모델을 준비합니다.\r\n첫 설치에는 인터넷과 수 GB의 여유 공간이 필요하며, 다운로드에 시간이 걸립니다.\r\nPython·Node.js는 자동 준비합니다. Microsoft 구성요소가 없으면 승인을 요청합니다.";
        intro.SetBounds(30, 87, 640, 87);
        startup.Text = "Windows 로그인 시 분석 서버 자동 준비";
        startup.SetBounds(30, 179, 610, 30);
        status.Text = "준비됨 · Windows 10/11 x64";
        status.SetBounds(30, 227, 640, 30);
        progress.SetBounds(30, 264, 640, 16);
        log.SetBounds(30, 295, 640, 138);
        log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical;
        log.Font = new Font("Malgun Gothic", 9); log.BackColor = Color.White;
        log.Text = "설치 위치: " + root;
        install.Text = "온소리 설치"; install.SetBounds(30, 455, 640, 48);
        install.BackColor = Color.FromArgb(36, 95, 216); install.ForeColor = Color.White;
        install.FlatStyle = FlatStyle.Flat;
        chrome.Text = "① 확장 폴더 복사 + Chrome 설정 열기"; chrome.SetBounds(30, 516, 640, 45); chrome.Enabled = false;
        watch.Text = "② 등록 완료 · YouTube 열기"; watch.SetBounds(30, 573, 640, 45); watch.Enabled = false;
        Controls.AddRange(new Control[] {title, intro, startup, status, progress, log, install, chrome, watch});
        install.Click += async delegate {
            busy = true; install.Enabled = false; startup.Enabled = false;
            bool login = startup.Checked;
            try {
                int code = await Task.Run(() => { Extract(); return RunScript("install-runtime.ps1", login ? "-LoginStartup" : ""); });
                if (code != 0) throw new Exception("설치를 완료하지 못했습니다. 인터넷 연결과 디스크 공간을 확인한 뒤 다시 시도해 주세요.\r\n기존 다운로드는 재사용합니다. 로그: " + Path.Combine(root, "runtime", "setup.log"));
                code = await Task.Run(() => RunScript("start.ps1", "-NoBrowser"));
                if (code != 0) throw new Exception("설치는 완료됐지만 서버를 시작하지 못했습니다. runtime/server-error.log를 확인해 주세요.");
                ShowReady();
            } catch (Exception ex) { Record(ex.Message); status.Text = "설치가 중단되었습니다 · 다시 시도할 수 있습니다"; install.Text = "다시 시도"; install.Enabled = true; startup.Enabled = true; }
            finally { busy = false; }
        };
        chrome.Click += delegate {
            try { Clipboard.SetText(Path.Combine(root, "extension")); OpenChrome("chrome://extensions/"); status.Text = "폴더 경로 복사 완료 · 개발자 모드 → 압축해제된 확장 로드"; }
            catch (Exception ex) { MessageBox.Show(ex.Message + "\r\n폴더: " + Path.Combine(root, "extension")); }
        };
        watch.Click += async delegate {
            watch.Enabled = false;
            try {
                if (await Task.Run(() => RunScript("start.ps1", "-NoBrowser")) != 0) throw new Exception("서버를 시작하지 못했습니다. 설치 로그를 확인해 주세요.");
                OpenChrome("https://www.youtube.com/");
            } catch(Exception ex) { MessageBox.Show(ex.Message); }
            finally { watch.Enabled = true; }
        };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) { e.Cancel = true; MessageBox.Show("설치가 진행 중입니다. 다운로드와 검사가 끝날 때까지 기다려 주세요.", "온소리"); } };
    }

    void ShowReady() {
        status.Text = "설치 완료! Chrome에 한 번만 등록하면 됩니다.";
        intro.Text = "아래 ①을 누르면 확장 폴더 경로가 복사되고 Chrome 설정이 열립니다.\r\n개발자 모드 켜기 → ‘압축해제된 확장 프로그램을 로드합니다’ →\r\n폴더 선택 창의 주소창에서 Alt+D, Ctrl+V, Enter → ‘폴더 선택’을 눌러 주세요.";
        install.Text = "설치 완료 · 바탕화면 OnSori로 다시 시작할 수 있습니다";
        install.Enabled = false; startup.Enabled = false; progress.Value = 100;
        chrome.Enabled = true; watch.Enabled = true;
    }

    static void OpenChrome(string url) {
        string[] candidates = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google/Chrome/Application/chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google/Chrome/Application/chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google/Chrome/Application/chrome.exe")
        };
        foreach (string candidate in candidates) if (File.Exists(candidate)) { Process.Start(candidate, url); return; }
        throw new Exception("Google Chrome이 필요합니다. google.com/chrome에서 설치한 뒤 이 버튼을 다시 눌러 주세요.");
    }

    void Record(string line) {
        if (String.IsNullOrEmpty(line)) return;
        lock (logLock) {
            Directory.CreateDirectory(Path.Combine(root, "runtime"));
            File.AppendAllText(Path.Combine(root, "runtime/setup.log"), line + Environment.NewLine, new UTF8Encoding(false));
        }
        if (IsHandleCreated && !IsDisposed) BeginInvoke((Action)(() => {
            if (line.StartsWith("PROGRESS:")) {
                string[] pieces = line.Split(new char[]{':'}, 3);
                int number;
                if (pieces.Length == 3 && Int32.TryParse(pieces[1], out number)) { progress.Value = Math.Min(100, Math.Max(0, number)); status.Text = pieces[2]; }
            }
            if (log.TextLength > 20000) log.Text = log.Text.Substring(log.TextLength - 10000);
            log.AppendText(Environment.NewLine + line);
        }));
    }

    int RunScript(string script, string options) {
        var info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell/v1.0/powershell.exe"));
        info.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "scripts", script) + "\" " + options;
        info.WorkingDirectory = root; info.UseShellExecute = false; info.CreateNoWindow = true;
        // PowerShell 7 can export an incompatible module path to Windows PowerShell 5.1.
        info.EnvironmentVariables.Remove("PSModulePath");
        info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
        using (var process = new Process {StartInfo = info}) {
            process.OutputDataReceived += (s,e) => Record(e.Data);
            process.ErrorDataReceived += (s,e) => Record(e.Data);
            process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
            process.WaitForExit(); return process.ExitCode;
        }
    }

    void Extract() {
        if (!Environment.Is64BitOperatingSystem) throw new Exception("Windows x64 PC가 필요합니다.");
        Directory.CreateDirectory(root);
        // Never replace code under a running local server. Other installations remain untouched.
        foreach (var process in Process.GetProcessesByName("python")) {
            string file = null;
            try { file = process.MainModule.FileName; } catch { }
            if (file != null && file.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new Exception("이 온소리가 실행 중입니다. 설치 폴더의 Stop-OnSori.cmd로 종료한 후 다시 시도해 주세요.");
        }
        string basePath = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
            // Validate every packaged file before modifying the install directory.
            string manifest;
            using(var reader = new StreamReader(zip.GetEntry("onsori/SOURCE-SHA256SUMS.txt").Open())) manifest = reader.ReadToEnd();
            foreach (string line in manifest.Split(new char[]{'\n'}, StringSplitOptions.RemoveEmptyEntries)) {
                string name = line.Substring(66).TrimEnd('\r');
                var entry = zip.GetEntry("onsori/" + name);
                using (var sha = SHA256.Create()) using (var input = entry.Open()) {
                    string digest = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                    if (digest != line.Substring(0,64)) throw new Exception("설치 파일 검증 실패: " + name);
                }
            }
            foreach(var entry in zip.Entries) {
                if (!entry.FullName.StartsWith("onsori/")) throw new Exception("잘못된 설치 파일 경로");
                string dest = Path.GetFullPath(Path.Combine(root, entry.FullName.Substring(7).Replace('/', Path.DirectorySeparatorChar)));
                if (!dest.StartsWith(basePath, StringComparison.OrdinalIgnoreCase)) throw new Exception("잘못된 설치 파일 경로");
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                entry.ExtractToFile(dest, true);
            }
        }
        string launcher = Path.Combine(root, "OnSori.exe");
        if (!String.Equals(Application.ExecutablePath, launcher, StringComparison.OrdinalIgnoreCase)) File.Copy(Application.ExecutablePath, launcher, true);
        Record("PROGRESS:2:프로그램 파일 검증 완료");
    }
}
