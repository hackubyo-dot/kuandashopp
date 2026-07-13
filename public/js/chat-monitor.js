// Monitoramento de Notificações em Tempo Real
document.addEventListener('DOMContentLoaded', () => {
    let lastUnreadCount = 0;
    // Som de notificação (url pública confiável)
    const notificationSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');

    function checkNotifications() {
        fetch('/api/chat/check')
            .then(res => res.json())
            .then(data => {
                const unread = data.unread || 0;
                
                // Atualiza Badge no Menu (se existir elemento .badge-notif)
                const badge = document.querySelector('.badge-notif');
                if (badge) {
                    badge.innerText = unread;
                    badge.style.display = unread > 0 ? 'inline-block' : 'none';
                }

                // Se houver novas mensagens desde a última checagem
                if (unread > lastUnreadCount) {
                    try {
                        notificationSound.play().catch(e => console.log('Interação pendente'));
                    } catch(e) {}
                    
                    // Mostra Toast Visual
                    if (data.lastMsg) {
                        showToastNotification(data.lastMsg);
                    }
                }
                lastUnreadCount = unread;
            })
            .catch(err => console.error('Erro polling chat:', err));
    }

    function showToastNotification(msg) {
        const div = document.createElement('div');
        div.style.cssText = `
            position: fixed; top: 20px; right: 20px; 
            background: #E31C25; color: white; 
            padding: 15px 25px; border-radius: 8px; 
            z-index: 99999; box-shadow: 0 5px 15px rgba(0,0,0,0.3);
            font-family: sans-serif; font-weight: bold;
            animation: slideInLeft 0.5s;
        `;
        div.innerHTML = `<i class="fas fa-bell"></i> &nbsp; ${msg}`;
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 4000);
    }

    // Verifica a cada 4 segundos
    setInterval(checkNotifications, 4000);
});