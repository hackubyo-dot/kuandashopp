// Global add to cart function
window.addToCart = function(produtoId, produtoNome, produtoPreco, produtoImagem) {
  // Show loading indicator
  const button = event.target;
  const originalText = button.innerHTML;
  button.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>Adicionando...';
  button.disabled = true;
  
  // Send request to add to cart
  fetch('/carrinho/adicionar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `produto_id=${produtoId}&quantidade=1`
  })
  .then(response => {
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    return response.json();
  })
  .then(data => {
    if (data.success) {
      // Show success toast
      showToast('success', `${produtoNome} adicionado ao carrinho!`);
      
      // Update cart count in navbar
      updateCartCount();
      
      // If on product page, update the page cart count
      const productCartCount = document.getElementById('productCartCount');
      if (productCartCount) {
        const currentCount = parseInt(productCartCount.textContent) || 0;
        productCartCount.textContent = currentCount + 1;
      }
    } else {
      showToast('error', data.message || 'Erro ao adicionar ao carrinho');
    }
  })
  .catch(error => {
    console.error('Error:', error);
    showToast('error', 'Erro ao adicionar ao carrinho');
  })
  .finally(() => {
    // Restore button state after 1.5 seconds
    setTimeout(() => {
      button.innerHTML = originalText;
      button.disabled = false;
    }, 1500);
  });
}

// Show toast notification
function showToast(type, message) {
  // Remove existing toasts
  const existingToasts = document.querySelectorAll('.toast-container');
  existingToasts.forEach(toast => toast.remove());
  
  const toastContainer = document.createElement('div');
  toastContainer.className = 'toast-container position-fixed top-0 end-0 p-3';
  toastContainer.style.zIndex = '9999';
  
  // Map type to Bootstrap classes
  const typeClasses = {
    'success': 'bg-success',
    'error': 'bg-danger',
    'warning': 'bg-warning',
    'info': 'bg-info'
  };
  
  const toastId = 'toast-' + Date.now();
  const toastHtml = `
    <div id="${toastId}" class="toast align-items-center text-white ${typeClasses[type] || 'bg-primary'} border-0" role="alert">
      <div class="d-flex">
        <div class="toast-body">
          <i class="${type === 'success' ? 'fas fa-check-circle' : type === 'error' ? 'fas fa-exclamation-circle' : 'fas fa-info-circle'} me-2"></i>
          ${message}
        </div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>
  `;
  
  toastContainer.innerHTML = toastHtml;
  document.body.appendChild(toastContainer);
  
  const toastElement = document.getElementById(toastId);
  const toast = new bootstrap.Toast(toastElement, {
    autohide: true,
    delay: 3000
  });
  toast.show();
  
  // Remove toast after hiding
  toastElement.addEventListener('hidden.bs.toast', function () {
    this.closest('.toast-container').remove();
  });
}

// Update cart count in navbar
function updateCartCount() {
  fetch('/carrinho/quantidade')
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        const cartCountElements = document.querySelectorAll('#cartCount, .cart-count');
        cartCountElements.forEach(el => {
          el.textContent = data.quantidade;
          // Show/hide badge based on count
          if (data.quantidade > 0) {
            el.classList.remove('d-none');
          } else {
            el.classList.add('d-none');
          }
        });
      }
    })
    .catch(error => {
      console.error('Error updating cart count:', error);
    });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
  updateCartCount();
  
  // Add confirmation for remove buttons
  document.querySelectorAll('form[action="/carrinho/remover"] button').forEach(button => {
    button.addEventListener('click', function(e) {
      if (!confirm('Tem certeza que deseja remover este item do carrinho?')) {
        e.preventDefault();
      }
    });
  });
  
  // Add quantity change handlers
  document.querySelectorAll('input[name="quantidade"]').forEach(input => {
    input.addEventListener('change', function(e) {
      const form = this.closest('form');
      const originalValue = this.defaultValue;
      
      if (this.value < 1) {
        this.value = 1;
      }
      
      // Show loading on the input
      const originalHtml = this.outerHTML;
      this.outerHTML = '<div class="spinner-border spinner-border-sm text-primary" role="status"><span class="visually-hidden">Carregando...</span></div>';
      
      fetch(form.action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(new FormData(form))
      })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          // Reload page to update totals
          window.location.reload();
        } else {
          showToast('error', data.message || 'Erro ao atualizar quantidade');
          // Restore original input
          this.outerHTML = originalHtml;
        }
      })
      .catch(error => {
        console.error('Error:', error);
        showToast('error', 'Erro ao atualizar quantidade');
        this.outerHTML = originalHtml;
      });
    });
  });
});