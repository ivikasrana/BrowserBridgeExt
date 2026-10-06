import { api } from './env';

const q = new URLSearchParams(location.search);
document.getElementById('tool')!.textContent = q.get('tool') ?? 'act';
document.getElementById('host')!.textContent = q.get('host') ?? '';

for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-d]')) {
  b.onclick = async () => {
    await api.runtime.sendMessage({ t: 'approve', id: q.get('id'), d: b.dataset.d });
    window.close();
  };
}
