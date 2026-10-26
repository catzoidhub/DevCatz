import { createApp } from 'vue';
import App from './App.vue';
import './assets/main.css';

// A file dropped outside a drop zone (Storage file browser) must not open in the window.
for (const type of ['dragover', 'drop'] as const)
  document.addEventListener(type, (e) => {
    if (!e.dataTransfer?.types.includes('Files') || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });

createApp(App).mount('#app');
