# Windows playback for the readout: plays one WAV file and returns when done.
#   play.ps1 -Path <file.wav>                  the default output device (SoundPlayer)
#   play.ps1 -Path <file.wav> -Device <name>   that output device (waveOut); the
#                                              name may be a part of the device's
#                                              name. Not found: the default device.
#   play.ps1 -List                             the output device names, one per line
# The system's default device is never changed.
param([string]$Path, [string]$Device = '', [switch]$List)

function Play-Default([string]$File) {
  $player = New-Object System.Media.SoundPlayer $File
  $player.Load()
  $player.PlaySync()
  $player.Dispose()
}

if (-not $List -and -not $Device) { Play-Default $Path; exit 0 }

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class VoiceReadoutWaveOut {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WAVEOUTCAPS {
    public ushort wMid; public ushort wPid; public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
    public uint dwFormats; public ushort wChannels; public ushort wReserved1; public uint dwSupport;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct WAVEHDR {
    public IntPtr lpData; public uint dwBufferLength; public uint dwBytesRecorded; public IntPtr dwUser;
    public uint dwFlags; public uint dwLoops; public IntPtr lpNext; public IntPtr reserved;
  }
  [DllImport("winmm.dll")] static extern uint waveOutGetNumDevs();
  [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "waveOutGetDevCapsW")] static extern uint waveOutGetDevCaps(UIntPtr id, ref WAVEOUTCAPS caps, uint size);
  [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr h, UIntPtr id, byte[] fmt, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] static extern uint waveOutUnprepareHeader(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] static extern uint waveOutReset(IntPtr h);
  [DllImport("winmm.dll")] static extern uint waveOutClose(IntPtr h);

  public static string[] Devices() {
    int n = (int)waveOutGetNumDevs();
    string[] names = new string[n];
    for (int i = 0; i < n; i++) {
      WAVEOUTCAPS c = new WAVEOUTCAPS();
      names[i] = waveOutGetDevCaps(new UIntPtr((uint)i), ref c, (uint)Marshal.SizeOf(typeof(WAVEOUTCAPS))) == 0 ? c.szPname : "";
    }
    return names;
  }

  // waveOut names are cut at 31 characters, so a longer name given in the
  // config matches the device whose cut name it starts with.
  public static int Find(string want) {
    string w = want.Trim().ToLowerInvariant();
    string[] names = Devices();
    for (int i = 0; i < names.Length; i++) if (names[i].ToLowerInvariant() == w) return i;
    for (int i = 0; i < names.Length; i++) { string d = names[i].ToLowerInvariant(); if (d.Length > 0 && (d.Contains(w) || w.StartsWith(d))) return i; }
    return -1;
  }

  // Plays a RIFF/WAVE file on device `dev`; the fmt chunk goes to waveOut as is.
  public static bool Play(string path, int dev) {
    byte[] wav = File.ReadAllBytes(path);
    if (wav.Length < 12 || BitConverter.ToUInt32(wav, 0) != 0x46464952) return false;
    byte[] fmt = null; int dataOff = -1, dataLen = 0, off = 12;
    while (off + 8 <= wav.Length) {
      string id = System.Text.Encoding.ASCII.GetString(wav, off, 4);
      int len = (int)BitConverter.ToUInt32(wav, off + 4);
      if (id == "fmt ") { fmt = new byte[Math.Max(len, 18)]; Array.Copy(wav, off + 8, fmt, 0, Math.Min(len, wav.Length - off - 8)); }
      if (id == "data") { dataOff = off + 8; dataLen = Math.Min(len, wav.Length - dataOff); break; }
      off += 8 + len + (len % 2);
    }
    if (fmt == null || dataOff < 0 || dataLen <= 0) return false;
    IntPtr h;
    if (waveOutOpen(out h, new UIntPtr((uint)dev), fmt, IntPtr.Zero, IntPtr.Zero, 0) != 0) return false;
    IntPtr data = Marshal.AllocHGlobal(dataLen);
    int hdrSize = Marshal.SizeOf(typeof(WAVEHDR));
    IntPtr hdr = Marshal.AllocHGlobal(hdrSize);
    try {
      Marshal.Copy(wav, dataOff, data, dataLen);
      WAVEHDR wh = new WAVEHDR(); wh.lpData = data; wh.dwBufferLength = (uint)dataLen;
      Marshal.StructureToPtr(wh, hdr, false);
      if (waveOutPrepareHeader(h, hdr, (uint)hdrSize) != 0) return false;
      if (waveOutWrite(h, hdr, (uint)hdrSize) != 0) { waveOutUnprepareHeader(h, hdr, (uint)hdrSize); return false; }
      int flagsOff = (int)Marshal.OffsetOf(typeof(WAVEHDR), "dwFlags");
      while ((Marshal.ReadInt32(hdr, flagsOff) & 1) == 0) Thread.Sleep(50);   // WHDR_DONE
      waveOutUnprepareHeader(h, hdr, (uint)hdrSize);
      return true;
    } finally {
      waveOutReset(h); waveOutClose(h);
      Marshal.FreeHGlobal(hdr); Marshal.FreeHGlobal(data);
    }
  }
}
'@

if ($List) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [VoiceReadoutWaveOut]::Devices() | Where-Object { $_ } | ForEach-Object { $_ }; exit 0 }

$dev = [VoiceReadoutWaveOut]::Find($Device)
if ($dev -lt 0) {
  [Console]::Error.WriteLine("voice-readout: no output device matches '$Device'; playing on the default device")
  Play-Default $Path; exit 0
}
if (-not [VoiceReadoutWaveOut]::Play($Path, $dev)) {
  [Console]::Error.WriteLine("voice-readout: waveOut could not play on '$Device'; playing on the default device")
  Play-Default $Path
}
exit 0
