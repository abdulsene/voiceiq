import express, { Request, Response } from "express";

const router = express.Router();

const ACTIVATION_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Activate Your Account - Neverr</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      color: #374151;
    }
    .container {
      background: white; border-radius: 16px; box-shadow: 0 20px 40px rgba(0,0,0,0.1);
      width: 100%; max-width: 480px; padding: 40px; margin: 20px;
    }
    .header { text-align: center; margin-bottom: 40px; }
    .logo { font-size: 24px; font-weight: 700; color: #4f46e5; margin-bottom: 12px; }
    .subtitle { color: #6b7280; font-size: 16px; }
    .form-group { margin-bottom: 24px; }
    label { display: block; margin-bottom: 8px; font-weight: 600; color: #374151; }
    input {
      width: 100%; padding: 12px 16px; border: 2px solid #e5e7eb; border-radius: 8px;
      font-size: 16px; transition: all 0.2s;
    }
    input:focus { outline: none; border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.1); }
    .btn {
      width: 100%; background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white;
      border: none; padding: 14px; border-radius: 8px; font-size: 16px; font-weight: 600;
      cursor: pointer; transition: all 0.2s;
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(79,70,229,0.3); }
    .btn:disabled { background: #9ca3af; cursor: not-allowed; transform: none; }
    .alert { padding: 12px; border-radius: 8px; margin-bottom: 20px; }
    .alert-error { background: #fef2f2; border: 1px solid #fecaca; color: #dc2626; }
    .alert-success { background: #f0fdf4; border: 1px solid #bbf7d0; color: #059669; }
    .requirements { font-size: 14px; color: #6b7280; margin-top: 8px; padding-left: 20px; }
    .requirements li { margin: 4px 0; }
    .loading { display: none; text-align: center; }
    .spinner { border: 2px solid #e5e7eb; border-top: 2px solid #4f46e5; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 0 auto 12px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">Neverr</div>
      <div class="subtitle">Activate your account to get started</div>
    </div>

    <div id="loading" class="loading">
      <div class="spinner"></div>
      <p>Activating your account...</p>
    </div>

    <form id="activationForm" onsubmit="activateAccount(event)">
      <div id="alertContainer"></div>

      <div class="form-group">
        <label for="email">Email Address</label>
        <input type="email" id="email" name="email" required readonly />
      </div>

      <div class="form-group">
        <label for="password">Create Password</label>
        <input type="password" id="password" name="password" required />
        <ul class="requirements">
          <li>At least 8 characters long</li>
          <li>Include uppercase and lowercase letters</li>
          <li>Include at least one number</li>
          <li>Include at least one special character</li>
        </ul>
      </div>

      <div class="form-group">
        <label for="confirmPassword">Confirm Password</label>
        <input type="password" id="confirmPassword" name="confirmPassword" required />
      </div>

      <button type="submit" class="btn" id="activateBtn">
        Activate Account & Sign In
      </button>
    </form>
  </div>

  <script>
    var urlParams = new URLSearchParams(window.location.search);
    var token = urlParams.get('token');
    var email = urlParams.get('email');
    // Tenant invites land here too (?type=team) — endpoint differs.
    var inviteType = urlParams.get('type') || 'team';

    if (email) {
      document.getElementById('email').value = decodeURIComponent(email);
    }

    if (!token || !email) {
      showAlert('Invalid activation link. Please check your email for the correct link.', 'error');
      document.getElementById('activateBtn').disabled = true;
    }

    function showAlert(message, type) {
      var alertContainer = document.getElementById('alertContainer');
      alertContainer.innerHTML = '<div class="alert alert-' + type + '">' + message + '</div>';
    }

    function validatePassword(password) {
      var requirements = [
        { test: /.{8,}/, message: "At least 8 characters" },
        { test: /[a-z]/, message: "Lowercase letter" },
        { test: /[A-Z]/, message: "Uppercase letter" },
        { test: /[0-9]/, message: "Number" },
        { test: /[^A-Za-z0-9]/, message: "Special character" }
      ];
      var failed = requirements.filter(function (req) { return !req.test.test(password); });
      return failed.length === 0 ? null : "Password must include: " + failed.map(function (f) { return f.message; }).join(", ");
    }

    async function activateAccount(event) {
      event.preventDefault();

      var password = document.getElementById('password').value;
      var confirmPassword = document.getElementById('confirmPassword').value;

      var passwordError = validatePassword(password);
      if (passwordError) { showAlert(passwordError, 'error'); return; }
      if (password !== confirmPassword) { showAlert('Passwords do not match.', 'error'); return; }

      document.getElementById('loading').style.display = 'block';
      document.getElementById('activationForm').style.display = 'none';

      var endpoint = inviteType === 'staff'
        ? '/api/admin/users/activate'
        : '/api/admin/team/activate';

      try {
        var response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token, email: email, password: password })
        });

        var data = await response.json();

        if (response.ok) {
          showAlert('Account activated successfully! Redirecting...', 'success');
          setTimeout(function () { window.location.href = '/'; }, 1500);
        } else {
          throw new Error(data.error || 'Activation failed');
        }
      } catch (error) {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('activationForm').style.display = 'block';
        showAlert(error.message, 'error');
      }
    }
  </script>
</body>
</html>`;

router.get("/activate", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.send(ACTIVATION_HTML);
});

export default router;
