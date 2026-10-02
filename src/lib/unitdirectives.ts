/**
 * Every setting systemd v259 reads from a unit file, by section, with a
 * one-letter kind saying how its value is read. Generated from systemd's own
 * src/core/load-fragment-gperf.gperf.in by scripts/unit-directives.ts — do not
 * edit by hand; regenerate for a new systemd.
 *
 * Kinds: b boolean, t time span (T in nanoseconds), n unsigned, i integer,
 * x command line, u unit names, U one unit, o obsolete dependency, r removed,
 * e environment, f environment file, p absolute path (F: refusing the unit
 * when it is not), a absolute paths, P PID file, w working directory,
 * s string with specifiers, c timer trigger, m file mode, z memory size,
 * Z size, l resource limit, g signal, k user or group, K users or groups,
 * d URLs, q path condition, Q condition, % percentage, N nice level,
 * O output, I input, E a fixed set of words, D directory names, R absolute
 * paths with - and + prefixes, X task limit, W cgroup weight, C capability
 * names, ? anything else.
 */

export const SYSTEMD_VERSION = "259";

/** Directives of each section, as "Name:kind" separated by spaces. */
export const SECTION_DIRECTIVES: Readonly<Record<string, string>> = {
  Unit:
    "Description:s Documentation:d SourcePath:p Requires:u Requisite:u Wants:u BindsTo:u BindTo:u " +
    "Upholds:u Conflicts:u Before:u After:u OnSuccess:u OnFailure:u PropagatesReloadTo:u " +
    "PropagateReloadTo:u ReloadPropagatedFrom:u PropagateReloadFrom:u PropagatesStopTo:u " +
    "StopPropagatedFrom:u PartOf:u JoinsNamespaceOf:u RequiresOverridable:o RequisiteOverridable:o " +
    "RequiresMountsFor:a WantsMountsFor:a StopWhenUnneeded:b RefuseManualStart:b RefuseManualStop:b " +
    "AllowIsolate:b DefaultDependencies:b SurviveFinalKillSignal:b OnSuccessJobMode:E " +
    "OnFailureJobMode:E OnFailureIsolate:b IgnoreOnIsolate:b IgnoreOnSnapshot:r JobTimeoutSec:t " +
    "JobRunningTimeoutSec:t JobTimeoutAction:E JobTimeoutRebootArgument:? StartLimitIntervalSec:t " +
    "StartLimitInterval:t StartLimitBurst:n StartLimitAction:E FailureAction:E SuccessAction:E " +
    "FailureActionExitStatus:? SuccessActionExitStatus:? RebootArgument:? ConditionPathExists:q " +
    "ConditionPathExistsGlob:q ConditionPathIsDirectory:q ConditionPathIsSymbolicLink:q " +
    "ConditionPathIsMountPoint:q ConditionPathIsReadWrite:q ConditionPathIsEncrypted:q " +
    "ConditionDirectoryNotEmpty:q ConditionFileNotEmpty:q ConditionFileIsExecutable:q " +
    "ConditionNeedsUpdate:q ConditionFirstBoot:Q ConditionArchitecture:Q ConditionFirmware:Q " +
    "ConditionVirtualization:Q ConditionHost:Q ConditionKernelCommandLine:Q ConditionKernelVersion:Q " +
    "ConditionVersion:Q ConditionCredential:Q ConditionSecurity:Q ConditionCapability:Q " +
    "ConditionACPower:Q ConditionMemory:Q ConditionCPUFeature:Q ConditionCPUs:Q " +
    "ConditionEnvironment:Q ConditionUser:Q ConditionGroup:Q ConditionControlGroupController:Q " +
    "ConditionOSRelease:Q ConditionMemoryPressure:Q ConditionCPUPressure:Q ConditionIOPressure:Q " +
    "ConditionKernelModuleLoaded:Q AssertPathExists:q AssertPathExistsGlob:q AssertPathIsDirectory:q " +
    "AssertPathIsSymbolicLink:q AssertPathIsMountPoint:q AssertPathIsReadWrite:q " +
    "AssertPathIsEncrypted:q AssertDirectoryNotEmpty:q AssertFileNotEmpty:q AssertFileIsExecutable:q " +
    "AssertNeedsUpdate:q AssertFirstBoot:Q AssertArchitecture:Q AssertVirtualization:Q AssertHost:Q " +
    "AssertKernelCommandLine:Q AssertKernelVersion:Q AssertVersion:Q AssertCredential:Q " +
    "AssertSecurity:Q AssertCapability:Q AssertACPower:Q AssertMemory:Q AssertCPUFeature:Q " +
    "AssertCPUs:Q AssertEnvironment:Q AssertUser:Q AssertGroup:Q AssertControlGroupController:Q " +
    "AssertOSRelease:Q AssertMemoryPressure:Q AssertCPUPressure:Q AssertIOPressure:Q " +
    "AssertKernelModuleLoaded:Q CollectMode:E ",
  Service:
    "PIDFile:P ExecCondition:x ExecStartPre:x ExecStart:x ExecStartPost:x ExecReload:x " +
    "ExecReloadPost:x ExecStop:x ExecStopPost:x RestartSec:t RestartSteps:n RestartMaxDelaySec:t " +
    "TimeoutSec:t TimeoutStartSec:t TimeoutStopSec:t TimeoutAbortSec:t TimeoutStartFailureMode:E " +
    "TimeoutStopFailureMode:E RuntimeMaxSec:t RuntimeRandomizedExtraSec:t WatchdogSec:t " +
    "StartLimitInterval:t StartLimitBurst:n StartLimitAction:E FailureAction:E RebootArgument:s " +
    "Type:E ExitType:E Restart:E RestartMode:E PermissionsStartOnly:b RootDirectoryStartOnly:b " +
    "RemainAfterExit:b GuessMainPID:b RestartPreventExitStatus:? RestartForceExitStatus:? " +
    "SuccessExitStatus:? SysVStartPriority:r NonBlocking:b BusName:s FileDescriptorStoreMax:n " +
    "FileDescriptorStorePreserve:E NotifyAccess:E Sockets:u BusPolicy:r USBFunctionDescriptors:p " +
    "USBFunctionStrings:p OOMPolicy:E OpenFile:? ReloadSignal:g ",
  Socket:
    "ListenStream:? ListenDatagram:? ListenSequentialPacket:? ListenFIFO:? ListenNetlink:? " +
    "ListenSpecial:? ListenMessageQueue:? ListenUSBFunction:? SocketProtocol:? BindIPv6Only:? " +
    "Backlog:n BindToDevice:? ExecStartPre:x ExecStartPost:x ExecStopPre:x ExecStopPost:x " +
    "TimeoutSec:t SocketUser:k SocketGroup:k SocketMode:m DirectoryMode:m Accept:b FlushPending:b " +
    "Writable:b MaxConnections:n MaxConnectionsPerSource:n KeepAlive:b KeepAliveTimeSec:t " +
    "KeepAliveIntervalSec:t KeepAliveProbes:n DeferAcceptSec:t NoDelay:b Priority:i ReceiveBuffer:Z " +
    "SendBuffer:Z IPTOS:? IPTTL:i Mark:i PipeSize:Z FreeBind:b Transparent:b Broadcast:b " +
    "PassCredentials:b PassPIDFD:b PassSecurity:b PassPacketInfo:b AcceptFileDescriptors:b " +
    "Timestamping:? TCPCongestion:? ReusePort:b MessageQueueMaxMessages:i MessageQueueMessageSize:i " +
    "RemoveOnStop:b Symlinks:? FileDescriptorName:? Service:? PassFileDescriptorsToExec:b " +
    "TriggerLimitIntervalSec:t TriggerLimitBurst:n PollLimitIntervalSec:t PollLimitBurst:n " +
    "DeferTrigger:? DeferTriggerMaxSec:t SmackLabel:s SmackLabelIPIn:s SmackLabelIPOut:s " +
    "SELinuxContextFromNet:b ",
  Mount:
    "What:? Where:p Options:s Type:s TimeoutSec:t DirectoryMode:m SloppyOptions:b LazyUnmount:b " +
    "ForceUnmount:b ReadWriteOnly:b ",
  Automount:
    "Where:p ExtraOptions:s DirectoryMode:m TimeoutIdleSec:t ",
  Swap:
    "What:? Priority:? Options:s TimeoutSec:t ",
  Timer:
    "OnCalendar:c OnActiveSec:c OnBootSec:c OnStartupSec:c OnUnitActiveSec:c OnUnitInactiveSec:c " +
    "OnClockChange:b OnTimezoneChange:b Persistent:b WakeSystem:b RemainAfterElapse:b " +
    "FixedRandomDelay:b DeferReactivation:b AccuracySec:t RandomizedDelaySec:t RandomizedOffsetSec:t " +
    "Unit:U ",
  Path:
    "PathExists:p PathExistsGlob:p PathChanged:p PathModified:p DirectoryNotEmpty:p Unit:U " +
    "MakeDirectory:b DirectoryMode:m TriggerLimitIntervalSec:t TriggerLimitBurst:n ",
  Slice:
    "ConcurrencySoftMax:? ConcurrencyHardMax:? ",
  Scope:
    "RuntimeMaxSec:t RuntimeRandomizedExtraSec:t TimeoutStopSec:t OOMPolicy:E ",
  Install:
    "Alias:u WantedBy:u RequiredBy:u UpheldBy:u Also:u DefaultInstance:s ",
};

/** The shared sets several sections take in: exec, kill and cgroup settings. */
export const SHARED_DIRECTIVES: Readonly<Record<string, string>> = {
  exec:
    "WorkingDirectory:w RootDirectory:F RootImage:F RootImageOptions:? RootImagePolicy:? RootHash:? " +
    "RootHashSignature:? RootVerity:F RootEphemeral:b ExtensionDirectories:R ExtensionImages:? " +
    "ExtensionImagePolicy:? MountImages:? MountImagePolicy:? User:k Group:k SupplementaryGroups:K " +
    "SetLoginEnvironment:b Nice:N OOMScoreAdjust:? CoredumpFilter:? IOSchedulingClass:E " +
    "IOSchedulingPriority:? CPUSchedulingPolicy:E CPUSchedulingPriority:? CPUSchedulingResetOnFork:b " +
    "CPUAffinity:? NUMAPolicy:? NUMAMask:? UMask:m Environment:e EnvironmentFile:f PassEnvironment:? " +
    "UnsetEnvironment:? DynamicUser:b RemoveIPC:b StandardInput:I StandardOutput:O StandardError:O " +
    "StandardInputText:? StandardInputData:? TTYPath:p TTYReset:b TTYVHangup:b TTYVTDisallocate:b " +
    "TTYRows:? TTYColumns:? SyslogIdentifier:s SyslogFacility:E SyslogLevel:E SyslogLevelPrefix:b " +
    "LogLevelMax:E LogRateLimitIntervalSec:t LogRateLimitBurst:n LogExtraFields:? LogFilterPatterns:? " +
    "Capabilities:r SecureBits:? CapabilityBoundingSet:C AmbientCapabilities:C TimerSlackNSec:T " +
    "NoNewPrivileges:b KeyringMode:E ProtectProc:E ProcSubset:E PrivateBPF:E BPFDelegateCommands:? " +
    "BPFDelegateMaps:? BPFDelegatePrograms:? BPFDelegateAttachments:? SystemCallFilter:? " +
    "SystemCallArchitectures:? SystemCallErrorNumber:? SystemCallLog:? MemoryDenyWriteExecute:b " +
    "RestrictNamespaces:? RestrictRealtime:b RestrictSUIDSGID:b RestrictAddressFamilies:? " +
    "LockPersonality:b DelegateNamespaces:? RestrictFileSystems:? LimitCPU:l LimitFSIZE:l LimitDATA:l " +
    "LimitSTACK:l LimitCORE:l LimitRSS:l LimitNOFILE:l LimitAS:l LimitNPROC:l LimitMEMLOCK:l " +
    "LimitLOCKS:l LimitSIGPENDING:l LimitMSGQUEUE:l LimitNICE:l LimitRTPRIO:l LimitRTTIME:l " +
    "ReadWriteDirectories:R ReadOnlyDirectories:R InaccessibleDirectories:R ReadWritePaths:R " +
    "ReadOnlyPaths:R InaccessiblePaths:R ExecPaths:R NoExecPaths:R ExecSearchPath:? BindPaths:? " +
    "BindReadOnlyPaths:? TemporaryFileSystem:? PrivateTmp:E PrivateDevices:b ProtectKernelTunables:b " +
    "ProtectKernelModules:b ProtectKernelLogs:b ProtectClock:b ProtectControlGroups:E " +
    "UserNamespacePath:p NetworkNamespacePath:p IPCNamespacePath:p LogNamespace:? PrivateNetwork:b " +
    "PrivateUsers:E PrivateMounts:b PrivateIPC:b PrivatePIDs:E ProtectSystem:E ProtectHome:E " +
    "MountFlags:E MountAPIVFS:b BindLogSockets:b Personality:? RuntimeDirectoryPreserve:E " +
    "RuntimeDirectoryMode:m RuntimeDirectory:D StateDirectoryMode:m StateDirectoryAccounting:b " +
    "StateDirectoryQuota:? StateDirectory:D CacheDirectoryMode:m CacheDirectoryAccounting:b " +
    "CacheDirectoryQuota:? CacheDirectory:D LogsDirectoryMode:m LogsDirectoryAccounting:b " +
    "LogsDirectoryQuota:? LogsDirectory:D ConfigurationDirectoryMode:m ConfigurationDirectory:D " +
    "SetCredential:? SetCredentialEncrypted:? LoadCredential:? LoadCredentialEncrypted:? " +
    "ImportCredential:? TimeoutCleanSec:t PAMName:s IgnoreSIGPIPE:b UtmpIdentifier:s UtmpMode:E " +
    "SELinuxContext:? AppArmorProfile:? SmackProcessLabel:? ProtectHostname:E MemoryKSM:b ",
  kill:
    "SendSIGKILL:b SendSIGHUP:b KillMode:E KillSignal:g RestartKillSignal:g FinalKillSignal:g " +
    "WatchdogSignal:g ",
  cgroup:
    "Slice:U AllowedCPUs:? StartupAllowedCPUs:? AllowedMemoryNodes:? StartupAllowedMemoryNodes:? " +
    "CPUAccounting:r CPUWeight:W StartupCPUWeight:W CPUShares:r StartupCPUShares:r CPUQuota:% " +
    "CPUQuotaPeriodSec:t MemoryAccounting:b MemoryMin:z DefaultMemoryMin:z DefaultMemoryLow:z " +
    "DefaultStartupMemoryLow:z MemoryLow:z StartupMemoryLow:z MemoryHigh:z StartupMemoryHigh:z " +
    "MemoryMax:z StartupMemoryMax:z MemorySwapMax:z StartupMemorySwapMax:z MemoryZSwapMax:z " +
    "StartupMemoryZSwapMax:z MemoryZSwapWriteback:b MemoryLimit:r DeviceAllow:? DevicePolicy:E " +
    "IOAccounting:b IOWeight:W StartupIOWeight:W IODeviceWeight:? IOReadBandwidthMax:? " +
    "IOWriteBandwidthMax:? IOReadIOPSMax:? IOWriteIOPSMax:? IODeviceLatencyTargetSec:? " +
    "BlockIOAccounting:r BlockIOWeight:r StartupBlockIOWeight:r BlockIODeviceWeight:r " +
    "BlockIOReadBandwidth:r BlockIOWriteBandwidth:r TasksAccounting:b TasksMax:X Delegate:? " +
    "DelegateSubgroup:? DisableControllers:? IPAccounting:b IPAddressAllow:? IPAddressDeny:? " +
    "IPIngressFilterPath:? IPEgressFilterPath:? ManagedOOMSwap:? ManagedOOMMemoryPressure:? " +
    "ManagedOOMMemoryPressureLimit:? ManagedOOMMemoryPressureDurationSec:? ManagedOOMPreference:? " +
    "NetClass:r BPFProgram:? SocketBindAllow:? SocketBindDeny:? RestrictNetworkInterfaces:? " +
    "MemoryPressureThresholdSec:t MemoryPressureWatch:? NFTSet:? CoredumpReceive:b ",
};

/** Which shared sets each section takes in. */
export const SECTION_SHARES: Readonly<Record<string, readonly string[]>> = {
  Service: ["exec", "cgroup", "kill"],
  Socket: ["exec", "cgroup", "kill"],
  Mount: ["exec", "cgroup", "kill"],
  Swap: ["exec", "cgroup", "kill"],
  Slice: ["cgroup"],
  Scope: ["cgroup", "kill"],
};
