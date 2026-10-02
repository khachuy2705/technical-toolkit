/**
 * One sentence on what a unit-file setting does, in English and Vietnamese,
 * for the settings people actually write. The rest of the ~550 systemd knows
 * are recognised from unitdirectives.ts and linked to their manual page.
 */

import type { Both } from "../data/i18n";

const d = (en: string, vi: string): Both => ({ en, vi });

export const DIRECTIVE_DOCS: Readonly<Record<string, Both>> = {
  // [Unit]
  Description: d(
    "A short title for the unit, shown by systemctl status and in boot messages.",
    "Tên ngắn của unit, hiện trong systemctl status và thông báo lúc khởi động.",
  ),
  Documentation: d(
    "Where the unit is documented: http(s)://, man:, info: or file: links, separated by spaces.",
    "Nơi có tài liệu của unit: các liên kết http(s)://, man:, info: hoặc file:, cách nhau bằng dấu cách.",
  ),
  Requires: d(
    "Units that must start along with this one; if one fails to start or is stopped, this one stops too. It says nothing about order — add After= for that.",
    "Các unit bắt buộc khởi động cùng unit này; nếu một unit trong đó không khởi động được hoặc bị dừng, unit này cũng dừng. Không quy định thứ tự — cần thêm After=.",
  ),
  Wants: d(
    "Units started along with this one; if they fail, this one carries on. It says nothing about order.",
    "Các unit được khởi động kèm theo; nếu chúng lỗi, unit này vẫn chạy tiếp. Không quy định thứ tự.",
  ),
  Requisite: d(
    "Like Requires=, except the units must already be running: systemd will not start them.",
    "Giống Requires=, nhưng các unit đó phải đang chạy sẵn: systemd sẽ không khởi động chúng.",
  ),
  BindsTo: d(
    "Like Requires=, and stronger: this unit also stops whenever the other one stops or disappears.",
    "Giống Requires= nhưng chặt hơn: unit này cũng dừng mỗi khi unit kia dừng hoặc biến mất.",
  ),
  PartOf: d(
    "Stopping or restarting the listed units stops or restarts this one too — not the other way round.",
    "Dừng hoặc khởi động lại các unit được liệt kê thì unit này cũng dừng hoặc khởi động lại — không có chiều ngược lại.",
  ),
  Upholds: d(
    "Keeps the listed units running: if one stops, systemd starts it again while this unit is up.",
    "Giữ các unit được liệt kê luôn chạy: nếu một unit dừng, systemd khởi động lại nó khi unit này còn chạy.",
  ),
  Conflicts: d(
    "Units that cannot run at the same time as this one: starting one stops the other.",
    "Các unit không được chạy cùng lúc với unit này: khởi động bên này sẽ dừng bên kia.",
  ),
  After: d(
    "Start this unit only once the listed units have finished starting, and stop it before them. Order only — it does not start them.",
    "Chỉ khởi động unit này sau khi các unit được liệt kê đã khởi động xong, và dừng nó trước chúng. Chỉ quy định thứ tự — không tự khởi động chúng.",
  ),
  Before: d(
    "Start this unit before the listed units, and stop it after them. Order only.",
    "Khởi động unit này trước các unit được liệt kê, và dừng nó sau chúng. Chỉ quy định thứ tự.",
  ),
  OnFailure: d(
    "Units to start when this one fails — a service that sends an alert, for instance.",
    "Các unit được khởi động khi unit này lỗi — chẳng hạn một service gửi cảnh báo.",
  ),
  OnSuccess: d(
    "Units to start when this one finishes successfully.",
    "Các unit được khởi động khi unit này chạy xong thành công.",
  ),
  StartLimitIntervalSec: d(
    "With StartLimitBurst=, the window in which starts are counted; more than the burst and systemd refuses further starts. 10 seconds by default.",
    "Cùng StartLimitBurst=, khoảng thời gian đếm số lần khởi động; quá số lần cho phép thì systemd từ chối khởi động tiếp. Mặc định 10 giây.",
  ),
  StartLimitBurst: d(
    "How many starts are allowed within StartLimitIntervalSec= — 5 by default.",
    "Số lần khởi động được phép trong StartLimitIntervalSec= — mặc định 5.",
  ),
  DefaultDependencies: d(
    "With no, systemd adds none of its usual implicit dependencies on the boot and shutdown targets — for units needed very early or very late.",
    "Đặt no thì systemd không thêm các phụ thuộc ngầm thông thường vào target khởi động và tắt máy — dành cho unit cần chạy rất sớm hoặc rất muộn.",
  ),
  RefuseManualStart: d(
    "Refuse systemctl start: the unit can only be started as a dependency.",
    "Từ chối systemctl start: unit chỉ khởi động được khi là phụ thuộc của unit khác.",
  ),
  RefuseManualStop: d(
    "Refuse systemctl stop: the unit can only be stopped as a dependency.",
    "Từ chối systemctl stop: unit chỉ dừng được khi là phụ thuộc của unit khác.",
  ),
  StopWhenUnneeded: d(
    "Stop the unit when nothing that needs it is running any more.",
    "Dừng unit khi không còn unit nào cần đến nó đang chạy.",
  ),
  FailureAction: d(
    "What the system does when the unit fails: none, reboot, poweroff, exit and their -force and -immediate forms.",
    "Hệ thống làm gì khi unit lỗi: none, reboot, poweroff, exit và các dạng -force, -immediate.",
  ),
  SuccessAction: d(
    "What the system does when the unit finishes successfully, with the same choices as FailureAction=.",
    "Hệ thống làm gì khi unit chạy xong thành công, với các lựa chọn giống FailureAction=.",
  ),
  RequiresMountsFor: d(
    "Paths whose mount units this unit requires and orders itself after.",
    "Các đường dẫn mà unit này cần mount sẵn, và được xếp sau các mount unit đó.",
  ),

  // [Service]
  Type: d(
    "How systemd decides the service has started: simple and exec (the process itself is the service), forking (it forks and the parent exits), oneshot (it runs to completion), notify (it says when it is ready), dbus (when it takes its bus name).",
    "Cách systemd xác định service đã khởi động xong: simple và exec (chính tiến trình là service), forking (tiến trình fork rồi tiến trình cha thoát), oneshot (chạy đến khi xong), notify (tự báo khi sẵn sàng), dbus (khi lấy được tên trên bus).",
  ),
  ExecStart: d(
    "The command that runs the service. No shell runs it: pipes, redirections and && are passed as plain arguments — write /bin/sh -c '…' for those.",
    "Lệnh chạy service. Không có shell nào chạy nó: pipe, chuyển hướng và && bị truyền như tham số thường — muốn dùng thì viết /bin/sh -c '…'.",
  ),
  ExecStartPre: d(
    "Commands run before ExecStart=, in order. If one fails, the start fails — unless it is prefixed with -.",
    "Các lệnh chạy trước ExecStart=, theo thứ tự. Một lệnh lỗi thì việc khởi động thất bại — trừ khi có dấu - ở đầu.",
  ),
  ExecStartPost: d(
    "Commands run after the service has started. If one fails, the service is stopped — unless it is prefixed with -.",
    "Các lệnh chạy sau khi service đã khởi động. Một lệnh lỗi thì service bị dừng — trừ khi có dấu - ở đầu.",
  ),
  ExecCondition: d(
    "A check run before ExecStartPre=: exit codes 1 to 254 skip the start quietly, 255 makes it fail.",
    "Lệnh kiểm tra chạy trước ExecStartPre=: mã thoát 1 đến 254 bỏ qua việc khởi động một cách êm, 255 làm nó thất bại.",
  ),
  ExecReload: d(
    "The command for systemctl reload — usually a signal to the process: /bin/kill -HUP $MAINPID.",
    "Lệnh cho systemctl reload — thường là gửi tín hiệu tới tiến trình: /bin/kill -HUP $MAINPID.",
  ),
  ExecStop: d(
    "The command that stops the service. Afterwards systemd kills whatever is left, as KillMode= says.",
    "Lệnh dừng service. Sau đó systemd diệt những tiến trình còn sót, theo KillMode=.",
  ),
  ExecStopPost: d(
    "Commands run after the service has stopped, whether it stopped cleanly or not.",
    "Các lệnh chạy sau khi service đã dừng, dù nó dừng êm hay không.",
  ),
  Restart: d(
    "When to restart the process after it exits: no, on-success, on-failure, on-abnormal, on-watchdog, on-abort or always.",
    "Khi nào khởi động lại tiến trình sau khi nó thoát: no, on-success, on-failure, on-abnormal, on-watchdog, on-abort hoặc always.",
  ),
  RestartSec: d(
    "How long to wait before restarting — 100ms by default.",
    "Thời gian chờ trước khi khởi động lại — mặc định 100ms.",
  ),
  RestartSteps: d(
    "With RestartMaxDelaySec=, how many steps the delay between restarts grows in.",
    "Cùng RestartMaxDelaySec=, số bước mà thời gian chờ giữa các lần khởi động lại tăng dần.",
  ),
  RestartMaxDelaySec: d(
    "With RestartSteps=, the longest the delay between restarts grows to.",
    "Cùng RestartSteps=, thời gian chờ dài nhất giữa các lần khởi động lại.",
  ),
  TimeoutStartSec: d(
    "How long starting may take before the service counts as failed — 90s by default; infinity turns it off.",
    "Thời gian khởi động tối đa trước khi service bị coi là lỗi — mặc định 90s; infinity là tắt giới hạn.",
  ),
  TimeoutStopSec: d(
    "How long to wait for the service to stop before it is killed with SIGKILL — 90s by default.",
    "Thời gian chờ service dừng trước khi bị diệt bằng SIGKILL — mặc định 90s.",
  ),
  TimeoutSec: d(
    "Sets TimeoutStartSec= and TimeoutStopSec= together.",
    "Đặt cùng lúc TimeoutStartSec= và TimeoutStopSec=.",
  ),
  RuntimeMaxSec: d(
    "Stop the service once it has been running this long.",
    "Dừng service khi nó đã chạy được chừng này thời gian.",
  ),
  WatchdogSec: d(
    "The service must ping the watchdog through sd_notify() within this interval, or it is treated as failed.",
    "Service phải gửi tín hiệu watchdog qua sd_notify() trong khoảng thời gian này, nếu không sẽ bị coi là lỗi.",
  ),
  RemainAfterExit: d(
    "Keep the service active after its processes have exited — the usual choice for a Type=oneshot set-up task.",
    "Giữ service ở trạng thái active sau khi tiến trình đã thoát — lựa chọn thường dùng cho tác vụ thiết lập Type=oneshot.",
  ),
  PIDFile: d(
    "Where a Type=forking daemon writes its main process ID, so systemd knows which process to watch.",
    "Nơi một daemon Type=forking ghi ID tiến trình chính, để systemd biết cần theo dõi tiến trình nào.",
  ),
  BusName: d(
    "The D-Bus name the service takes; Type=dbus needs it.",
    "Tên D-Bus mà service sử dụng; Type=dbus bắt buộc phải có.",
  ),
  NotifyAccess: d(
    "Which processes may send readiness and status notifications: none, main, exec or all.",
    "Những tiến trình nào được gửi thông báo sẵn sàng và trạng thái: none, main, exec hoặc all.",
  ),
  SuccessExitStatus: d(
    "Extra exit codes and signals that count as a clean exit.",
    "Các mã thoát và tín hiệu khác được tính là thoát bình thường.",
  ),
  RestartPreventExitStatus: d(
    "Exit codes and signals after which the service is never restarted.",
    "Các mã thoát và tín hiệu mà sau đó service không bao giờ được khởi động lại.",
  ),
  OOMPolicy: d(
    "What happens when the kernel's out-of-memory killer kills one of the service's processes: continue, stop or kill.",
    "Điều gì xảy ra khi bộ diệt tiến trình hết bộ nhớ của kernel diệt một tiến trình của service: continue, stop hoặc kill.",
  ),
  PermissionsStartOnly: d(
    "Deprecated: prefix the commands that need privileges with + instead.",
    "Đã lỗi thời: thay vào đó hãy thêm dấu + trước các lệnh cần quyền cao.",
  ),

  // Process and sandbox settings, shared by service, socket, mount and swap units
  User: d(
    "The user the processes run as — root when not set.",
    "Người dùng mà tiến trình chạy dưới quyền — là root nếu không đặt.",
  ),
  Group: d(
    "The group the processes run as — the user's own group when not set.",
    "Nhóm mà tiến trình chạy dưới quyền — là nhóm của người dùng nếu không đặt.",
  ),
  SupplementaryGroups: d(
    "Extra groups for the processes, separated by spaces.",
    "Các nhóm bổ sung cho tiến trình, cách nhau bằng dấu cách.",
  ),
  DynamicUser: d(
    "Run as a temporary user created when the service starts and removed when it stops.",
    "Chạy dưới một người dùng tạm, được tạo khi service khởi động và xoá khi nó dừng.",
  ),
  WorkingDirectory: d(
    "The directory the processes start in: an absolute path, or ~ for the user's home; a leading - tolerates its absence.",
    "Thư mục làm việc khi tiến trình khởi động: đường dẫn tuyệt đối, hoặc ~ cho thư mục home của người dùng; dấu - ở đầu cho phép thư mục không tồn tại.",
  ),
  RootDirectory: d(
    "Run the processes chrooted into this directory.",
    "Chạy tiến trình trong chroot tại thư mục này.",
  ),
  Environment: d(
    "Environment variables as NAME=value, separated by spaces; quote a whole assignment that contains spaces: \"NAME=a b\".",
    "Biến môi trường dạng NAME=value, cách nhau bằng dấu cách; đặt cả phép gán trong ngoặc kép nếu có dấu cách: \"NAME=a b\".",
  ),
  EnvironmentFile: d(
    "A file of NAME=value lines to read variables from; a leading - tolerates its absence.",
    "Tệp chứa các dòng NAME=value để đọc biến môi trường; dấu - ở đầu cho phép tệp không tồn tại.",
  ),
  StandardOutput: d(
    "Where the processes' output goes: journal (the default), null, tty, kmsg, file:/path, append:/path, truncate:/path, socket or fd:name.",
    "Đầu ra của tiến trình đi đâu: journal (mặc định), null, tty, kmsg, file:/đường-dẫn, append:/đường-dẫn, truncate:/đường-dẫn, socket hoặc fd:tên.",
  ),
  StandardError: d(
    "Where error output goes, with the same choices as StandardOutput= — by default, wherever that goes.",
    "Đầu ra lỗi đi đâu, với các lựa chọn giống StandardOutput= — mặc định đi cùng chỗ với nó.",
  ),
  StandardInput: d(
    "Where the processes read input from: null (the default), tty, data, file:/path, socket or fd:name.",
    "Tiến trình đọc đầu vào từ đâu: null (mặc định), tty, data, file:/đường-dẫn, socket hoặc fd:tên.",
  ),
  SyslogIdentifier: d(
    "The name the service's messages carry in the journal.",
    "Tên gắn với các thông điệp của service trong journal.",
  ),
  LimitNOFILE: d(
    "The most files a process may have open — what ulimit -n shows.",
    "Số tệp tối đa một tiến trình được mở cùng lúc — chính là ulimit -n.",
  ),
  LimitNPROC: d(
    "The most processes the user may have — what ulimit -u shows.",
    "Số tiến trình tối đa người dùng được có — chính là ulimit -u.",
  ),
  LimitCORE: d(
    "The largest core dump a crash may write; 0 turns them off.",
    "Dung lượng core dump lớn nhất khi tiến trình gặp sự cố; 0 là tắt.",
  ),
  Nice: d(
    "CPU scheduling priority, from -20 (the most favourable) to 19.",
    "Độ ưu tiên lập lịch CPU, từ -20 (cao nhất) đến 19.",
  ),
  UMask: d(
    "The file mode creation mask, in octal — 0022 by default.",
    "Mặt nạ quyền khi tạo tệp, dạng bát phân — mặc định 0022.",
  ),
  NoNewPrivileges: d(
    "Stop the processes and their children from gaining privileges, through setuid binaries for instance.",
    "Không cho tiến trình và tiến trình con giành thêm quyền, chẳng hạn qua các tệp setuid.",
  ),
  ProtectSystem: d(
    "Mount /usr and /boot read-only (yes), /etc too (full), or the whole file system but /dev, /proc and /sys (strict).",
    "Mount /usr và /boot chỉ-đọc (yes), thêm cả /etc (full), hoặc toàn bộ hệ thống tệp trừ /dev, /proc và /sys (strict).",
  ),
  ProtectHome: d(
    "Hide /home, /root and /run/user (yes), make them read-only, or mount an empty tmpfs over them.",
    "Ẩn /home, /root và /run/user (yes), đặt chỉ-đọc (read-only), hoặc mount một tmpfs rỗng đè lên (tmpfs).",
  ),
  PrivateTmp: d(
    "Give the service its own private /tmp and /var/tmp.",
    "Cấp cho service thư mục /tmp và /var/tmp riêng.",
  ),
  PrivateDevices: d(
    "Give the service a minimal /dev with no physical devices.",
    "Cấp cho service một /dev tối giản, không có thiết bị vật lý nào.",
  ),
  PrivateNetwork: d(
    "Run the service in its own network namespace, with only a loopback device.",
    "Chạy service trong network namespace riêng, chỉ có thiết bị loopback.",
  ),
  ReadWritePaths: d(
    "Paths that stay writable under ProtectSystem= and similar settings.",
    "Các đường dẫn vẫn được ghi khi đã bật ProtectSystem= và các thiết lập tương tự.",
  ),
  ReadOnlyPaths: d(
    "Paths the service may read but not write.",
    "Các đường dẫn service chỉ được đọc, không được ghi.",
  ),
  InaccessiblePaths: d(
    "Paths the service cannot see at all.",
    "Các đường dẫn service hoàn toàn không truy cập được.",
  ),
  CapabilityBoundingSet: d(
    "The only Linux capabilities the processes may ever hold.",
    "Tập capability Linux duy nhất mà tiến trình có thể có.",
  ),
  AmbientCapabilities: d(
    "Capabilities given to a process that runs as a non-root user — CAP_NET_BIND_SERVICE to listen below port 1024, for instance.",
    "Capability cấp cho tiến trình chạy dưới người dùng không phải root — ví dụ CAP_NET_BIND_SERVICE để lắng nghe cổng dưới 1024.",
  ),
  RuntimeDirectory: d(
    "A directory under /run created for the service, owned by its user, and removed when it stops.",
    "Thư mục trong /run được tạo cho service, thuộc người dùng của nó, và bị xoá khi service dừng.",
  ),
  StateDirectory: d(
    "A directory under /var/lib created for the service and owned by its user.",
    "Thư mục trong /var/lib được tạo cho service và thuộc người dùng của nó.",
  ),
  LogsDirectory: d(
    "A directory under /var/log created for the service and owned by its user.",
    "Thư mục trong /var/log được tạo cho service và thuộc người dùng của nó.",
  ),
  CacheDirectory: d(
    "A directory under /var/cache created for the service and owned by its user.",
    "Thư mục trong /var/cache được tạo cho service và thuộc người dùng của nó.",
  ),
  ConfigurationDirectory: d(
    "A directory under /etc for the service's configuration.",
    "Thư mục trong /etc dành cho cấu hình của service.",
  ),
  KillMode: d(
    "Which processes are killed on stop: control-group (all of them, the default), mixed, process (the main one only) or none (deprecated).",
    "Những tiến trình nào bị diệt khi dừng: control-group (tất cả, mặc định), mixed, process (chỉ tiến trình chính) hoặc none (đã lỗi thời).",
  ),
  KillSignal: d(
    "The first signal sent on stop — SIGTERM by default.",
    "Tín hiệu đầu tiên được gửi khi dừng — mặc định SIGTERM.",
  ),
  SendSIGKILL: d(
    "Whether processes still running after TimeoutStopSec= get SIGKILL.",
    "Có gửi SIGKILL cho tiến trình còn chạy sau TimeoutStopSec= hay không.",
  ),

  // Resource control
  MemoryMax: d(
    "A hard memory limit: past it the out-of-memory killer acts. K, M, G and T suffixes, a percentage, or infinity.",
    "Giới hạn bộ nhớ cứng: vượt quá thì bộ diệt tiến trình hết bộ nhớ ra tay. Dùng hậu tố K, M, G, T, phần trăm, hoặc infinity.",
  ),
  MemoryHigh: d(
    "A memory throttling point: past it the processes are slowed down and their memory reclaimed.",
    "Ngưỡng hãm bộ nhớ: vượt quá thì tiến trình bị làm chậm và bộ nhớ bị thu hồi.",
  ),
  CPUQuota: d(
    "A cap on CPU time as a percentage of one CPU — 200% is two whole CPUs.",
    "Giới hạn thời gian CPU theo phần trăm của một CPU — 200% là trọn hai CPU.",
  ),
  CPUWeight: d(
    "A share of CPU time when CPUs are contended, from 1 to 10000 — 100 by default.",
    "Phần chia thời gian CPU khi các tiến trình tranh nhau, từ 1 đến 10000 — mặc định 100.",
  ),
  IOWeight: d(
    "A share of disk I/O when it is contended, from 1 to 10000 — 100 by default.",
    "Phần chia I/O ổ đĩa khi có tranh chấp, từ 1 đến 10000 — mặc định 100.",
  ),
  TasksMax: d(
    "The most processes and threads the unit may have.",
    "Số tiến trình và luồng tối đa của unit.",
  ),
  Slice: d(
    "The slice the unit's processes are placed in, for grouping resource limits.",
    "Slice chứa các tiến trình của unit, để nhóm các giới hạn tài nguyên.",
  ),

  // [Timer]
  OnCalendar: d(
    "Elapse at calendar times, written as a systemd calendar event — the OnCalendar explainer reads them.",
    "Chạy theo các thời điểm trên lịch, viết theo cú pháp lịch của systemd — xem công cụ giải thích OnCalendar.",
  ),
  OnBootSec: d(
    "Elapse this long after the machine booted.",
    "Chạy sau khi máy khởi động được chừng này thời gian.",
  ),
  OnStartupSec: d(
    "Elapse this long after the service manager started — for a user's manager, after they logged in.",
    "Chạy sau khi trình quản lý dịch vụ khởi động được chừng này thời gian — với trình quản lý của người dùng là sau khi đăng nhập.",
  ),
  OnActiveSec: d(
    "Elapse this long after the timer itself was started.",
    "Chạy sau khi chính timer được khởi động chừng này thời gian.",
  ),
  OnUnitActiveSec: d(
    "Elapse this long after the unit it starts last became active — a repeating interval.",
    "Chạy sau khi unit mà nó khởi động lần gần nhất chuyển sang active chừng này thời gian — tạo chu kỳ lặp lại.",
  ),
  OnUnitInactiveSec: d(
    "Elapse this long after the unit it starts last finished.",
    "Chạy sau khi unit mà nó khởi động lần gần nhất kết thúc chừng này thời gian.",
  ),
  AccuracySec: d(
    "How long systemd may delay an elapse to wake the machine less often — one minute by default.",
    "systemd được trễ mỗi lần chạy tối đa bao lâu để gộp các lần đánh thức máy — mặc định một phút.",
  ),
  RandomizedDelaySec: d(
    "Delay every elapse by a random amount up to this, to spread load across machines.",
    "Trễ mỗi lần chạy một khoảng ngẫu nhiên tối đa bằng giá trị này, để dàn tải giữa các máy.",
  ),
  FixedRandomDelay: d(
    "Use the same random delay every time on this machine, rather than a new one per elapse.",
    "Dùng cùng một khoảng trễ ngẫu nhiên mỗi lần trên máy này, thay vì chọn lại mỗi lần chạy.",
  ),
  Persistent: d(
    "Store the time of the last run on disk, and run once at start-up if one was missed while the machine was off. Only OnCalendar= timers.",
    "Lưu thời điểm chạy gần nhất lên đĩa, và chạy bù một lần khi khởi động nếu đã lỡ một lần lúc máy tắt. Chỉ áp dụng cho timer có OnCalendar=.",
  ),
  WakeSystem: d(
    "Wake the machine from suspend for the elapse.",
    "Đánh thức máy khỏi chế độ ngủ để chạy.",
  ),
  RemainAfterElapse: d(
    "Keep the timer loaded after its last elapse — yes by default.",
    "Giữ timer sau lần chạy cuối cùng — mặc định yes.",
  ),
  OnClockChange: d(
    "Elapse when the system clock jumps.",
    "Chạy khi đồng hồ hệ thống bị chỉnh nhảy.",
  ),
  OnTimezoneChange: d(
    "Elapse when the system's time zone changes.",
    "Chạy khi múi giờ của hệ thống thay đổi.",
  ),
  Unit: d(
    "The unit the timer or path unit starts — by default the .service with its own name.",
    "Unit mà timer hoặc path khởi động — mặc định là .service cùng tên với nó.",
  ),

  // [Socket]
  ListenStream: d(
    "A TCP port, an address and port, or a Unix socket path to listen on.",
    "Cổng TCP, địa chỉ kèm cổng, hoặc đường dẫn Unix socket để lắng nghe.",
  ),
  ListenDatagram: d(
    "A UDP port or datagram socket to listen on.",
    "Cổng UDP hoặc datagram socket để lắng nghe.",
  ),
  Accept: d(
    "With yes, start one instance of a template service (name@.service) per connection; with no, hand every connection to one service.",
    "Đặt yes thì khởi động một phiên bản service mẫu (tên@.service) cho mỗi kết nối; đặt no thì giao mọi kết nối cho một service.",
  ),
  Service: d(
    "The service the socket activates — by default the one with the socket's own name.",
    "Service mà socket kích hoạt — mặc định là service cùng tên với socket.",
  ),

  // [Path]
  PathExists: d(
    "Start the unit when this path exists.",
    "Khởi động unit khi đường dẫn này tồn tại.",
  ),
  PathChanged: d(
    "Start the unit when this file is closed after writing, or renamed.",
    "Khởi động unit khi tệp này được đóng sau khi ghi, hoặc bị đổi tên.",
  ),
  PathModified: d(
    "Start the unit whenever this file is written to.",
    "Khởi động unit mỗi khi tệp này được ghi.",
  ),
  DirectoryNotEmpty: d(
    "Start the unit when this directory has something in it.",
    "Khởi động unit khi thư mục này có nội dung.",
  ),

  // [Mount]
  What: d(
    "What to mount: a device node, a LABEL= or UUID=, an image file or a remote share.",
    "Thứ cần mount: tệp thiết bị, LABEL= hoặc UUID=, tệp ảnh đĩa hoặc thư mục chia sẻ từ xa.",
  ),
  Where: d(
    "Where to mount it — an absolute path that must match the unit's name.",
    "Mount vào đâu — một đường dẫn tuyệt đối phải khớp với tên unit.",
  ),
  Options: d(
    "Mount options, as for mount -o.",
    "Tuỳ chọn mount, như với mount -o.",
  ),

  // [Install]
  WantedBy: d(
    "When the unit is enabled, the listed targets want it: multi-user.target for a service that starts at boot, timers.target for a timer.",
    "Khi unit được enable, các target được liệt kê sẽ kéo nó theo: multi-user.target cho service chạy lúc khởi động, timers.target cho timer.",
  ),
  RequiredBy: d(
    "Like WantedBy=, but the targets require the unit rather than want it.",
    "Giống WantedBy=, nhưng target đòi bắt buộc chứ không chỉ muốn có unit.",
  ),
  Alias: d(
    "Extra names for the unit, made into links when it is enabled.",
    "Các tên khác của unit, được tạo thành liên kết khi enable.",
  ),
  Also: d(
    "Other units to enable and disable together with this one.",
    "Các unit khác được enable và disable cùng với unit này.",
  ),
  DefaultInstance: d(
    "For a template unit, the instance enabled when none is named.",
    "Với unit mẫu, phiên bản được enable khi không chỉ rõ.",
  ),
};

/** For the conditions and assertions, which come in dozens and work alike. */
export const CONDITION_DOC = d(
  "A check made before the unit starts: if it does not hold, the unit is skipped, without an error. ! negates it; | makes it one of several of which any may hold.",
  "Phép kiểm tra trước khi unit khởi động: nếu không thoả, unit bị bỏ qua mà không báo lỗi. Dấu ! đảo ngược; dấu | biến nó thành một trong nhiều điều kiện, chỉ cần một điều kiện đúng.",
);

export const ASSERT_DOC = d(
  "A check made before the unit starts: if it does not hold, the start fails with an error. ! negates it.",
  "Phép kiểm tra trước khi unit khởi động: nếu không thoả, việc khởi động thất bại và báo lỗi. Dấu ! đảo ngược.",
);
