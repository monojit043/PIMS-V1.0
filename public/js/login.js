// public/js/login.js - UPDATED WITH BANNER CAROUSEL

// Banner carousel functionality (from PIMSLogin.js)
let currentIndex = 0;
const images = document.querySelectorAll(".banner-img");

function showNextImage() {
  if (images.length > 1) {
    images[currentIndex].classList.remove("active");
    currentIndex = (currentIndex + 1) % images.length;
    images[currentIndex].classList.add("active");
  }
}

// Start banner carousel if there are multiple images
if (images.length > 1) {
  setInterval(showNextImage, 5000); // Change image every 5 seconds
}

// Your original login functionality (UNCHANGED)
document.addEventListener("DOMContentLoaded", () => {
  // Password visibility toggle
  const passwordInput = document.getElementById("password");
  const togglePassword = document.getElementById("togglePassword");
  const passwordContainer = document.querySelector(".password-container");

  if (togglePassword && passwordInput) {
    // Show eye icon when password field has content
    passwordInput.addEventListener("input", function () {
      if (this.value.length > 0) {
        passwordContainer.classList.add("show-eye");
      } else {
        passwordContainer.classList.remove("show-eye");
      }
    });

    // Toggle password visibility
    togglePassword.addEventListener("click", function () {
      if (passwordInput.type === "password") {
        passwordInput.type = "text";
        this.innerHTML = "🙈"; // Hidden eye when password is visible
      } else {
        passwordInput.type = "password";
        this.innerHTML = "👁️"; // Normal eye when password is hidden
      }
    });

    // Keep eye visible when password field is focused
    passwordInput.addEventListener("focus", function () {
      if (this.value.length > 0) {
        passwordContainer.classList.add("show-eye");
      }
    });
  }


  const form = document.getElementById("loginForm");
  const errorEl = document.getElementById("loginError");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.style.display = "none";
    const formData = new FormData(form);
    const payload = {
      employeeId: formData.get("employeeId")?.trim().toUpperCase(),
      password: formData.get("password") ?? ""
    };

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.message || "Invalid credentials");
      }

      window.location.href = data.redirect || "/user.html";
    } catch (err) {
      errorEl.textContent = err.message || "Invalid credentials";
      errorEl.style.display = "block";
    }
  });
});