# Deploying THS Stream 5 Watch to Oracle Cloud (Always Free)

This walks through getting your tracker running on a free, persistent Oracle
Cloud VM, from a blank OCI account to a working URL. Every step is copy-paste
ready. Total time: roughly 30–45 minutes the first time.

---

## Part 1 — Create your OCI account

1. Go to **cloud.oracle.com** and click **Start for free**.
2. Fill in your email, verify it, then set up your account details (name,
   company optional, country, cloud account name — pick anything memorable).
3. You'll be asked for a credit card. This is for identity verification only
   — staying within Always Free limits means you are not charged. Set a
   $1 budget alert later in Part 6 as a safety net.
4. Choose your **Home Region** carefully when prompted — you cannot easily
   change this later, and Always Free resources are tied to it. Pick the
   region geographically closest to you or your users (e.g. Canada Southeast
   - Toronto, if available; otherwise the nearest US region).
5. Wait for the "your account is ready" confirmation (can take a few minutes).

---

## Part 2 — Create the Always Free VM

1. Log into the **OCI Console**.
2. Open the hamburger menu (top left) → **Compute** → **Instances**.
3. Click **Create instance**.
4. **Name**: something like `ths-tracker`.
5. **Placement**: leave default (your home region/availability domain).
6. **Image and shape**:
   - Click **Edit** next to "Image and shape."
   - Image: choose **Canonical Ubuntu** (22.04 or newer LTS).
   - Shape: click **Change shape**, select **Ampere** (ARM-based), pick
     **VM.Standard.A1.Flex**, and set **1 OCPU / 6 GB memory** (well within
     the current Always Free allowance of 2 OCPU/12GB total, leaving room
     to spare or to add a second small VM later if you ever want one).
7. **Networking**: leave the default VCN settings (OCI creates one for you
   if you don't have one). Make sure **"Assign a public IPv4 address"** is
   checked — you need this to reach the server from outside.
8. **Add SSH keys**: select **Generate a key pair for me**, then click
   **Save private key** and **Save public key**. Store the private key file
   somewhere safe (e.g. `~/.ssh/oci-ths-tracker.key` on your Mac) — you
   cannot download it again later.
9. Leave boot volume settings as default (the free tier includes up to
   200GB total block storage, far more than this needs).
10. Click **Create**. Wait a few minutes for the instance state to become
    **Running**, then copy its **Public IP address** from the instance
    details page — you'll need it for every step below.

---

## Part 3 — Open the port so the portal is reachable

By default OCI blocks incoming traffic except SSH (port 22). You need to
open port 8787 (or 80, see the note at the end) for the web page to load.

1. From your instance's detail page, click the link under **Virtual cloud
   network** (it'll be named something like `vcn-...`).
2. Click into **Subnets** → your subnet → **Security Lists** → the default
   security list.
3. Click **Add Ingress Rules**.
4. Fill in:
   - Source CIDR: `0.0.0.0/0` (anyone can reach it — fine for an internal
     tool, but see the note on restricting this in Part 6 if you want it
     more private)
   - IP Protocol: TCP
   - Destination Port Range: `8787`
5. Click **Add Ingress Rules** to save.

Ubuntu's own firewall (`ufw`) is off by default on the OCI image, so no
second firewall step is usually needed — but if you ever enable `ufw`,
remember to also run `sudo ufw allow 8787`.

---

## Part 4 — Connect and install Node.js

On your Mac, open Terminal:

```bash
chmod 400 ~/.ssh/oci-ths-tracker.key
ssh -i ~/.ssh/oci-ths-tracker.key ubuntu@<YOUR_PUBLIC_IP>
```

Replace `<YOUR_PUBLIC_IP>` with the address from Part 2, step 10. Type
`yes` if asked about the host fingerprint.

Once connected, install Node.js (using NodeSource's setup script for a
current LTS version):

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

You should see a version like `v20.x.x` or newer.

---

## Part 5 — Upload and run your project

From a **second Terminal window on your Mac** (keep the SSH session open in
the first one), copy the project folder up to the server:

```bash
scp -i ~/.ssh/oci-ths-tracker.key -r /path/to/ths-portal ubuntu@<YOUR_PUBLIC_IP>:~/ths-portal
```

Replace `/path/to/ths-portal` with wherever you unzipped the project on your
Mac.

Back in your **first Terminal window** (the SSH session):

```bash
cd ~/ths-portal
npm install
npm start
```

You should see:
```
THS Stream 5 Tracker running at http://localhost:8787
```

Open a browser on your own computer and go to:

```
http://<YOUR_PUBLIC_IP>:8787
```

You should see the portal. Press `Ctrl+C` to stop it for now — the next
step makes it run permanently in the background.

---

## Part 6 — Keep it running permanently

Right now, the app stops the moment you close your SSH session. Use `pm2`
to keep it alive and auto-restart on reboot:

```bash
sudo npm install -g pm2
cd ~/ths-portal
pm2 start server/server.js --name ths-tracker
pm2 save
pm2 startup
```

That last command prints a `sudo env PATH=...` line — copy and run exactly
that line it gives you (it varies by system). This makes `pm2` resurrect
your app automatically if the VM ever restarts.

Check it's running:

```bash
pm2 status
pm2 logs ths-tracker --lines 20
```

You can now safely close your SSH session — the app keeps running.

---

## Optional but recommended: a few safety steps

**Set a budget alert.** In the OCI Console, go to **Governance &
Administration → Budgets → Create Budget**, set a $1 threshold, and add
your email. You'll be notified immediately if anything ever drifts outside
Always Free limits.

**Restrict who can reach the portal.** If this is only for your team, change
the ingress rule's Source CIDR in Part 3 from `0.0.0.0/0` to your office's
specific IP address (or a VPN range), rather than leaving it open to the
whole internet.

**Use port 80 instead of 8787**, so people can just type the IP address with
no port number. This needs a small change since regular users can't bind to
port 80 directly:

```bash
sudo apt-get install -y nginx
```

Then create `/etc/nginx/sites-available/ths-tracker` with:
```
server {
    listen 80;
    location / {
        proxy_pass http://localhost:8787;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/ths-tracker /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo systemctl restart nginx
```

Then open port 80 instead of 8787 in your security list (Part 3), and visit
just `http://<YOUR_PUBLIC_IP>` with no port number.

---

## Updating the app later

If you ever edit `server.js` or the keyword list:

```bash
scp -i ~/.ssh/oci-ths-tracker.key -r /path/to/ths-portal/server ubuntu@<YOUR_PUBLIC_IP>:~/ths-portal/
ssh -i ~/.ssh/oci-ths-tracker.key ubuntu@<YOUR_PUBLIC_IP> "pm2 restart ths-tracker"
```

## If something doesn't load

- `pm2 logs ths-tracker` on the server shows recent errors.
- Double check the security list port (Part 3) matches the port the app is
  actually running on.
- Confirm the instance is still **Running** in the OCI Console — Always
  Free instances can occasionally be reclaimed if left completely idle for
  very long periods; logging in and using it periodically avoids this.
