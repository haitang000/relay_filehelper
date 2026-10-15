import { useState, type FormEvent } from 'react';
import { Alert, Avatar, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, IconButton, InputAdornment, InputLabel, MenuItem, Select, TextField } from '@mui/material';
import { ArrowRight, Check, Eye, EyeOff, File, FileArchive, FileImage, FileSpreadsheet, FileText, LockKeyhole, Send, ShieldCheck } from 'lucide-react';
import { api, errorText, json, ttlLabel, type Config, type Room, type User } from './api';

export function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'small' : ''}`}><span className="brand-mark"><Send size={small ? 20 : 24} strokeWidth={1.8} /></span><span>轻传<span className="brand-en">RELAY</span></span></div>;
}
export function UserAvatar({ name, size = 32 }: { name: string; size?: number }) {
  const tones = [['#eeebff', '#6c61ba'], ['#e8f3ef', '#39856d'], ['#fff0e3', '#bc844d'], ['#e8effb', '#577dac']];
  const [background, color] = tones[Array.from(name).reduce((sum, c) => sum + c.codePointAt(0)!, 0) % tones.length];
  return <Avatar sx={{ width: size, height: size, bgcolor: background, color, fontSize: size * .38, fontWeight: 600 }}>{Array.from(name)[0]?.toUpperCase()}</Avatar>;
}
export function FileIcon({ name }: { name: string }) {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  let Icon = File, tone = 'purple';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'heic'].includes(extension)) { Icon = FileImage; tone = 'pink'; }
  else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) { Icon = FileArchive; tone = 'amber'; }
  else if (['xls', 'xlsx', 'csv'].includes(extension)) { Icon = FileSpreadsheet; tone = 'green'; }
  else if (['pdf', 'doc', 'docx', 'txt', 'md'].includes(extension)) { Icon = FileText; tone = extension === 'pdf' ? 'red' : 'blue'; }
  return <span className={`file-icon ${tone}`}><Icon size={21} strokeWidth={1.6} /></span>;
}
export function AuthScreen({ config, onLogin, notice }: { config: Config; onLogin: (user: User) => void; notice: string }) {
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState({username:false,password:false});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const invalidUsername = register && touched.username && !/^[\p{L}\p{N}_-]{2,24}$/u.test(username);
  const invalidPassword = register && touched.password && password.length < 10;
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (register && (!/^[\p{L}\p{N}_-]{2,24}$/u.test(username) || password.length < 10)) { setTouched({username:true,password:true}); return; }
    setBusy(true);
    try { onLogin(await api<User>(`/auth/${register ? 'register' : 'login'}`, json('POST', { username, password }))); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <div className="auth-page">
    <header className="auth-header"><Brand /><span className="auth-header-note">自托管文件传输助手</span></header>
    <main className="auth-layout">
      <section className="auth-story"><span className="auth-intro-label">少一点繁琐，多一点专注。</span><h1>一个房间，<br /><span>轻松收发文件。</span></h1><p>用配对码连接伙伴，<br />把文件发送给真正需要的人。</p><div className="auth-features"><span><Send size={17} />配对码入房，无需添加好友</span><span><LockKeyhole size={17} />指定接收人，文件按权限可见</span><span><Check size={17} />文件自动过期，省去手动清理</span></div></section>
      <section className="auth-form-card"><h2>{register ? '创建账号' : '登录轻传'}</h2><p>{register ? '一个账号，在不同设备继续分享。' : '登录后进入你的房间，继续收发文件。'}</p>{notice && <Alert severity="info" sx={{mb:2}}>{notice}</Alert>}
        <form onSubmit={submit}><TextField label="用户名" autoComplete="username" fullWidth disabled={busy} value={username} onChange={event => setUsername(event.target.value)} onBlur={() => setTouched(previous=>({...previous,username:true}))} required error={invalidUsername} inputProps={{maxLength:24}} helperText={register ? '2–24 位文字、数字、下划线或短横线' : ' '} /><TextField label="密码" type={showPassword ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} fullWidth disabled={busy} value={password} onChange={event => setPassword(event.target.value)} onBlur={() => setTouched(previous=>({...previous,password:true}))} required error={invalidPassword} inputProps={{minLength:register?10:1,maxLength:128}} helperText={register ? '至少 10 个字符' : ' '} InputProps={{endAdornment:<InputAdornment position="end"><IconButton disabled={busy} aria-label={showPassword?'隐藏密码':'显示密码'} onClick={()=>setShowPassword(previous=>!previous)} edge="end">{showPassword?<EyeOff size={18}/>:<Eye size={18}/>}</IconButton></InputAdornment>}} />{error && <Alert severity="error" sx={{mb:2}}>{error}</Alert>}<Button type="submit" variant="contained" fullWidth disabled={busy} endIcon={busy?<CircularProgress size={17}/>:<ArrowRight size={17}/>}>{busy?'请稍候…':register?'创建账号':'登录'}</Button></form>
        {config.registrationEnabled && <div className="auth-switch">{register?'已经有账号？':'还没有账号？'}<Button onClick={()=>{setRegister(previous=>!previous);setError('');setTouched({username:false,password:false});}}>{register?'登录':'注册账号'}</Button></div>}
        <div className="auth-form-foot"><ShieldCheck size={15}/>按权限分享 · 到期自动清理</div>
      </section>
    </main>
    <footer className="auth-footer"><span>轻传 RELAY</span><span>文件保留时间由房间管理员设置</span></footer>
  </div>;
}
export function RoomDialog({ mode, onClose, onDone }: { mode: 'create' | 'join' | null; onClose: () => void; onDone: (room: Room) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const room = await api<Room>(mode === 'create' ? '/rooms' : '/rooms/join', json('POST', mode === 'create' ? { name: value } : { code: value })); onDone(room); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <Dialog open={mode !== null} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs"><form onSubmit={submit}><DialogTitle>{mode === 'create' ? '创建一个新房间' : '通过配对码加入'}</DialogTitle><DialogContent><p className="dialog-description">{mode === 'create' ? '为这个分享空间取个名字，你将成为房间管理员。' : '输入好友分享的 8 位配对码，加入同一个分享空间。'}</p><TextField autoFocus fullWidth label={mode === 'create' ? '房间名称' : '8 位配对码'} value={value} onChange={e => setValue(e.target.value)} required inputProps={{ maxLength: mode === 'create' ? 40 : 16 }} />{error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}</DialogContent><DialogActions><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="contained" type="submit" disabled={busy || !value.trim()}>{busy ? '处理中…' : mode === 'create' ? '创建房间' : '加入房间'}</Button></DialogActions></form></Dialog>;
}
export function SettingsDialog({ room, onClose, onChange }: { room: Room; onClose: () => void; onChange: () => Promise<void> }) {
  const [ttl, setTtl] = useState(room.ttlHours);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  async function save() {
    setBusy(true); setError('');
    try { await api(`/rooms/${room.id}`, json('PATCH', { ttlHours: ttl })); await onChange(); onClose(); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  async function reset() {
    setBusy(true); setError('');
    try { await api(`/rooms/${room.id}/reset-code`, json('POST')); await onChange(); setConfirmReset(false); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="xs"><DialogTitle>房间设置</DialogTitle><DialogContent><p className="dialog-description">{room.name} · 管理员设置</p><FormControl fullWidth><InputLabel>新文件的默认有效期</InputLabel><Select value={ttl} label="新文件的默认有效期" onChange={e => setTtl(Number(e.target.value))}>{[1, 24, 168, 720].map(value => <MenuItem key={value} value={value}>{ttlLabel(value)}</MenuItem>)}</Select></FormControl><p className="field-note">仅影响之后上传成功的文件，已有文件的到期时间保持不变。</p><div className="reset-code"><strong>配对码</strong><code>{room.code}</code><p>重置后旧码立即失效，已经加入的成员不受影响。</p>{confirmReset ? <Alert severity="warning" action={<Button color="warning" size="small" disabled={busy} onClick={reset}>确认重置</Button>}>旧配对码将无法使用</Alert> : <Button variant="outlined" color="inherit" disabled={busy} onClick={() => setConfirmReset(true)}>重置配对码</Button>}</div>{error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}</DialogContent><DialogActions><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="contained" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存设置'}</Button></DialogActions></Dialog>;
}
