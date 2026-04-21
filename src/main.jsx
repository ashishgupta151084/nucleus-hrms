import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Show any errors on screen
window.addEventListener('error', (e) => {
  document.getElementById('root').innerHTML = 
    '<div style="padding:20px;font-family:monospace;font-size:12px;color:red;background:white">' +
    '<b>JavaScript Error:</b><br/>' + e.message + '<br/>' + (e.filename||'') + ':' + e.lineno +
    '</div>';
});

window.addEventListener('unhandledrejection', (e) => {
  document.getElementById('root').innerHTML = 
    '<div style="padding:20px;font-family:monospace;font-size:12px;color:red;background:white">' +
    '<b>Promise Error:</b><br/>' + (e.reason?.message || e.reason) +
    '</div>';
});

try {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} catch(e) {
  document.getElementById('root').innerHTML = 
    '<div style="padding:20px;font-family:monospace;font-size:12px;color:red;background:white">' +
    '<b>Render Error:</b><br/>' + e.message +
    '</div>';
}
