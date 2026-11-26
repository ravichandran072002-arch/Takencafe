const {app,BrowserWindow,shell}=require('electron');
const path=require('node:path');
function createWindow(){
 const win=new BrowserWindow({width:1280,height:850,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
 win.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith('https://'))shell.openExternal(url);return {action:'deny'};});
 win.webContents.on('will-navigate',(event,url)=>{if(url!==win.webContents.getURL()){event.preventDefault();if(url.startsWith('https://'))shell.openExternal(url);}});
 win.loadFile(path.join(__dirname,'index.html'));
}
app.whenReady().then(()=>{createWindow();app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length)createWindow();});});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
