"""qBittorrent Desktop Widget"""
import json
import logging
import os
import sys
import threading
import time
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Set
from urllib.parse import urlencode

import webview

# pywebview 6.x: only known settings keys are allowed (ImmutableDict).
# Drag works via class="pywebview-drag-region" on non-button elements.
# There is NO DRAG_REGION_EXCLUDE_SELECTOR in 6.2.1 — do not set it.
webview.settings['DRAG_REGION_SELECTOR'] = '.pywebview-drag-region'

try:
    import requests
    USE_REQUESTS = True
except ImportError:
    import urllib.request
    import http.cookiejar
    USE_REQUESTS = False
    print("[Warning] 'requests' library not found. Using urllib (less efficient).")
    print("Install with: pip install requests")


def env_first(*names: str, default: str = "") -> str:
    """Read the first non-empty environment variable from names."""
    for name in names:
        value = os.getenv(name)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return default


# ============================================================================
# Configuration
# ============================================================================

@dataclass
class Config:
    """Application configuration.

    Preferred env names match the web console proxy:
      QBIT_URL, QBIT_USERNAME, QBIT_PASSWORD, QBIT_DEBUG, QBIT_TIMEOUT_MS
    Legacy aliases still work: QB_URL, QB_USER, QB_PASS, QB_DEBUG
    """
    qb_url: str = env_first("QBIT_URL", "QB_URL", default="http://100.84.45.59:8085")
    qb_user: str = env_first("QBIT_USERNAME", "QB_USER", default="admin")
    qb_pass: str = env_first("QBIT_PASSWORD", "QB_PASS", default="admin")
    update_interval: float = 2.0
    request_timeout: int = 10
    window_width: int = 280
    window_height: int = 214
    debug: bool = env_first("QBIT_DEBUG", "QB_DEBUG", default="").lower() in ("1", "true", "yes")

    def __post_init__(self) -> None:
        self.qb_url = self.qb_url.strip().rstrip("/")
        timeout_raw = env_first("QBIT_TIMEOUT_MS", default="")
        if timeout_raw:
            try:
                ms = int(timeout_raw)
                if 1000 <= ms <= 120000:
                    self.request_timeout = max(1, ms // 1000)
            except ValueError:
                pass


STATE_DOWNLOADING: Set[str] = {"downloading", "forcedDL", "metaDL", "queuedDL"}
STATE_SEEDING: Set[str] = {"uploading", "forcedUP", "stalledUP", "queuedUP"}
STATE_PAUSED: Set[str] = {"pausedDL", "pausedUP", "stoppedDL", "stoppedUP"}
STATE_ERROR: Set[str] = {"error", "missingFiles"}


# ============================================================================
# Logging Setup
# ============================================================================

def setup_logging(debug: bool = False) -> logging.Logger:
    level = logging.DEBUG if debug else logging.INFO
    logger = logging.getLogger("qBitWidget")
    logger.setLevel(level)
    logger.handlers.clear()

    if sys.stderr is not None:
        handler: logging.Handler = logging.StreamHandler()
    else:
        handler = logging.NullHandler()

    handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S"
    ))
    logger.addHandler(handler)
    logger.propagate = False
    return logger


# ============================================================================
# API Client
# ============================================================================

class QBittorrentClient:
    """qBittorrent API client with session management."""

    def __init__(self, config: Config, logger: logging.Logger):
        self.config = config
        self.logger = logger
        self._logged_in = False
        self._lock = threading.Lock()

        if USE_REQUESTS:
            self.session = requests.Session()
            self.session.headers.update({"Referer": f"{config.qb_url}/"})
        else:
            self.cookie_jar = http.cookiejar.CookieJar()
            self.opener = urllib.request.build_opener(
                urllib.request.HTTPCookieProcessor(self.cookie_jar)
            )

    def login(self) -> bool:
        with self._lock:
            self.logger.info("Logging in to %s", self.config.qb_url)
            try:
                if USE_REQUESTS:
                    response = self.session.post(
                        f"{self.config.qb_url}/api/v2/auth/login",
                        data={
                            "username": self.config.qb_user,
                            "password": self.config.qb_pass
                        },
                        timeout=self.config.request_timeout
                    )
                    response.raise_for_status()
                    success = response.text.strip() == "Ok."
                else:
                    data = urlencode({
                        "username": self.config.qb_user,
                        "password": self.config.qb_pass
                    }).encode()
                    req = urllib.request.Request(
                        f"{self.config.qb_url}/api/v2/auth/login",
                        data=data,
                        headers={
                            "Content-Type": "application/x-www-form-urlencoded",
                            "Referer": f"{self.config.qb_url}/"
                        }
                    )
                    resp = self.opener.open(req, timeout=self.config.request_timeout)
                    success = "Ok." in resp.read().decode()

                self._logged_in = success
                if success:
                    self.logger.info("Login successful")
                else:
                    self.logger.warning("Login failed")
                return success
            except Exception as e:
                self.logger.error("Login error: %s", e)
                self._logged_in = False
                return False

    def _ensure_logged_in(self) -> bool:
        if not self._logged_in:
            return self.login()
        return True

    def get(self, path: str, retry_on_auth_fail: bool = True) -> Optional[Any]:
        if not self._ensure_logged_in():
            return None

        try:
            if USE_REQUESTS:
                response = self.session.get(
                    f"{self.config.qb_url}{path}",
                    timeout=self.config.request_timeout
                )
                response.raise_for_status()
                return response.json()
            req = urllib.request.Request(
                f"{self.config.qb_url}{path}",
                headers={"Referer": f"{self.config.qb_url}/"}
            )
            resp = self.opener.open(req, timeout=self.config.request_timeout)
            return json.loads(resp.read())
        except Exception as e:
            self.logger.debug("GET %s failed: %s", path, e)
            if retry_on_auth_fail:
                self._logged_in = False
                if self.login():
                    return self.get(path, retry_on_auth_fail=False)
            return None


# ============================================================================
# Widget API
# ============================================================================

class WidgetApi:
    """JavaScript API exposed to the webview."""

    def __init__(self, client: QBittorrentClient, logger: logging.Logger):
        self._client = client
        self._logger = logger
        self._window: Optional[Any] = None
        self._rid = 0
        self._torrents: Dict[str, Dict[str, Any]] = {}
        self._server_state: Dict[str, Any] = {}

    def set_window(self, window: Any) -> None:
        self._window = window

    def get_data(self) -> Dict[str, Any]:
        """Fetch stats via sync/maindata (incremental when possible)."""
        main_data = self._client.get(f"/api/v2/sync/maindata?rid={self._rid}")
        if not isinstance(main_data, dict):
            self._rid = 0
            self._torrents = {}
            self._server_state = {}
            return {"online": False}

        full_update = bool(main_data.get("full_update"))
        if full_update:
            self._torrents = {}
            self._server_state = {}

        server_state = main_data.get("server_state")
        if isinstance(server_state, dict):
            self._server_state.update(server_state)

        torrents_patch = main_data.get("torrents")
        if isinstance(torrents_patch, dict):
            for hash_key, patch in torrents_patch.items():
                if not isinstance(patch, dict):
                    continue
                prev = self._torrents.get(hash_key, {"hash": hash_key})
                merged = {**prev, **patch, "hash": patch.get("hash") or prev.get("hash") or hash_key}
                self._torrents[hash_key] = merged

        for hash_key in main_data.get("torrents_removed") or []:
            self._torrents.pop(str(hash_key), None)

        rid = main_data.get("rid")
        try:
            self._rid = int(rid) if rid is not None else 0
        except (TypeError, ValueError):
            self._rid = 0

        ss = self._server_state
        torrents = list(self._torrents.values())
        if not ss and not torrents and not full_update:
            # empty partial after a cold start without usable state
            self._rid = 0
            return {"online": False}

        stats = self._analyze_torrents(torrents)
        dl_speed = int(ss.get("dl_info_speed") or 0)
        ul_speed = int(ss.get("up_info_speed") or 0)
        # Prefer all-time totals for "???/???"; fall back to session counters.
        total_dl = ss.get("alltime_dl")
        total_ul = ss.get("alltime_ul")
        if total_dl is None:
            total_dl = ss.get("dl_info_data") or 0
        if total_ul is None:
            total_ul = ss.get("up_info_data") or 0
        try:
            total_dl = int(total_dl or 0)
        except (TypeError, ValueError):
            total_dl = 0
        try:
            total_ul = int(total_ul or 0)
        except (TypeError, ValueError):
            total_ul = 0

        free_space = ss.get("free_space_on_disk")
        try:
            free_space = int(free_space) if free_space is not None else None
        except (TypeError, ValueError):
            free_space = None

        # Global share ratio from server_state (same as WebUI). Fall back to
        # alltime_ul/alltime_dl, then average of torrent ratios.
        ratio = None
        gr = ss.get("global_ratio")
        if gr is not None and gr != "":
            try:
                ratio = float(gr)
            except (TypeError, ValueError):
                ratio = None
        if ratio is None and total_dl > 0:
            ratio = total_ul / total_dl
        if ratio is None:
            ratio = float(stats.get("ratio") or 0)
        stats["ratio"] = round(float(ratio), 3)

        self._logger.debug(
            "Stats: DL=%.1fKB/s UP=%.1fKB/s Torrents=%s/%s/%s/%s rid=%s ratio=%.3f",
            dl_speed / 1024,
            ul_speed / 1024,
            stats["nDl"],
            stats["nSd"],
            stats["nSt"],
            stats["nEr"],
            self._rid,
            stats["ratio"],
        )

        return {
            "online": True,
            "dl": dl_speed,
            "ul": ul_speed,
            "totalDl": total_dl,
            "totalUl": total_ul,
            "freeSpace": free_space,
            **stats,
        }

    def _analyze_torrents(self, torrents: list) -> Dict[str, Any]:
        n_dl = n_sd = n_st = n_er = 0
        total_eta = 0
        active_dl = 0
        ratio_sum = 0.0
        progress_sum = 0.0
        progress_count = 0

        for torrent in torrents:
            state = torrent.get("state", "")

            if state in STATE_DOWNLOADING:
                n_dl += 1
                eta = torrent.get("eta", -1)
                if isinstance(eta, (int, float)) and 0 < eta < 31536000:
                    total_eta += int(eta)
                    active_dl += 1
                progress_sum += float(torrent.get("progress") or 0)
                progress_count += 1
            elif state in STATE_SEEDING:
                n_sd += 1
            elif state in STATE_PAUSED:
                n_st += 1
            elif state in STATE_ERROR:
                n_er += 1

            ratio_sum += float(torrent.get("ratio") or 0)

        avg_eta = total_eta // active_dl if active_dl else 0
        avg_ratio = ratio_sum / len(torrents) if torrents else 0.0
        avg_progress = (progress_sum / progress_count) if progress_count else 0.0

        return {
            "nDl": n_dl,
            "nSd": n_sd,
            "nSt": n_st,
            "nEr": n_er,
            "avgEta": avg_eta,
            "ratio": round(avg_ratio, 2),
            "progressPct": round(avg_progress * 100, 1),
        }

    def open_webui(self) -> None:
        threading.Thread(target=self._open_webui_impl, daemon=True).start()

    def _open_webui_impl(self) -> None:
        webbrowser.open(self._client.config.qb_url)
        self._logger.info("Opened web UI")

    def hide_widget(self) -> None:
        """Hide window to tray (no taskbar entry)."""
        threading.Thread(target=self._hide_widget_impl, daemon=True).start()

    def _hide_widget_impl(self) -> None:
        if self._window is not None:
            try:
                self._window.hide()
            except Exception as e:
                self._logger.error("Hide failed: %s", e)

    def show_widget(self) -> None:
        threading.Thread(target=self._show_widget_impl, daemon=True).start()

    def _show_widget_impl(self) -> None:
        if self._window is not None:
            try:
                self._window.show()
            except Exception as e:
                self._logger.error("Show failed: %s", e)

    def close_widget(self) -> None:
        threading.Thread(target=self._close_widget_impl, daemon=True).start()

    def _close_widget_impl(self) -> None:
        tray = getattr(self, "_tray_icon", None)
        if tray is not None:
            try:
                tray.stop()
            except Exception:
                pass
        if self._window is not None:
            self._window.destroy()


# ============================================================================
# Main Application
# ============================================================================

def update_loop(api: WidgetApi, window: Any, config: Config, logger: logging.Logger) -> None:
    time.sleep(1.5)
    while True:
        try:
            if window is None:
                break
            data = api.get_data()
            js_code = f"updateData({json.dumps(data)})"
            window.evaluate_js(js_code)
        except Exception as e:
            msg = str(e)
            # Window not ready / destroyed — keep trying until process exits
            if "failed to start" in msg.lower() or "destroyed" in msg.lower():
                logger.debug("Update skipped: %s", e)
            else:
                logger.error("Update loop error: %s", e, exc_info=config.debug)
        time.sleep(config.update_interval)


def _make_tray_image():
    """Simple badge icon for system tray."""
    from PIL import Image, ImageDraw

    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((4, 4, 60, 60), radius=14, fill=(18, 26, 34, 255))
    draw.ellipse((12, 12, 30, 30), fill=(255, 102, 117, 255))
    draw.ellipse((34, 12, 52, 30), fill=(61, 222, 122, 255))
    draw.rectangle((16, 36, 48, 50), fill=(78, 196, 255, 230))
    return img


def _hide_from_taskbar(logger: logging.Logger) -> None:
    """Remove floating widget from Windows taskbar WITHOUT recreating the HWND.

    Setting WinForms ShowInTaskbar=False recreates the window handle and kills
    WebView2 (blank/invisible widget). Use ITaskbarList.DeleteTab instead.
    """
    try:
        import ctypes
        from ctypes import POINTER, byref, c_ubyte, c_uint16, c_uint32, c_void_p, HRESULT, wintypes
        from webview.platforms import winforms

        class GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", c_uint32),
                ("Data2", c_uint16),
                ("Data3", c_uint16),
                ("Data4", c_ubyte * 8),
            ]

        clsid = GUID(0x56FDF344, 0xFD6D, 0x11D0, (c_ubyte * 8)(0x95, 0x8A, 0x00, 0x60, 0x97, 0xC9, 0xA0, 0x90))
        iid = GUID(0x56FDF342, 0xFD6D, 0x11D0, (c_ubyte * 8)(0x95, 0x8A, 0x00, 0x60, 0x97, 0xC9, 0xA0, 0x90))

        ole32 = ctypes.OleDLL("ole32")
        try:
            ole32.CoInitialize(None)
        except Exception:
            pass

        punk = c_void_p()
        hr = ole32.CoCreateInstance(byref(clsid), None, 1, byref(iid), byref(punk))
        if hr != 0 or not punk.value:
            logger.debug("ITaskbarList create failed hr=%s", hr)
            return

        # vtable: QI, AddRef, Release, HrInit, AddTab, DeleteTab, ...
        vtbl = ctypes.cast(ctypes.cast(punk, POINTER(c_void_p))[0], POINTER(c_void_p))
        HrInit = ctypes.WINFUNCTYPE(HRESULT, c_void_p)(vtbl[3])
        DeleteTab = ctypes.WINFUNCTYPE(HRESULT, c_void_p, wintypes.HWND)(vtbl[5])
        HrInit(punk)

        for form in list(winforms.BrowserView.instances.values()):
            try:
                hwnd = int(form.Handle.ToInt32())
                DeleteTab(punk, hwnd)
                logger.info("Removed taskbar button for hwnd=%s", hwnd)
            except Exception as e:
                logger.debug("DeleteTab failed: %s", e)
    except Exception as e:
        logger.debug("hide taskbar skipped: %s", e)


def _start_tray(api: "WidgetApi", window: Any, logger: logging.Logger):
    """System tray icon. Start only AFTER WebView2 window is ready."""
    if getattr(api, "_tray_icon", None) is not None:
        return getattr(api, "_tray_icon")

    try:
        import pystray
        from pystray import MenuItem as Item
    except ImportError:
        logger.warning("pystray not installed; tray disabled (pip install pystray pillow)")
        return None

    def show(_icon=None, _item=None):
        try:
            window.show()
            _hide_from_taskbar(logger)
        except Exception as e:
            logger.error("Tray show failed: %s", e)

    def hide(_icon=None, _item=None):
        try:
            window.hide()
        except Exception as e:
            logger.error("Tray hide failed: %s", e)

    def open_webui(_icon=None, _item=None):
        api.open_webui()

    def quit_app(icon, _item=None):
        try:
            icon.stop()
        except Exception:
            pass
        api._tray_icon = None
        try:
            window.destroy()
        except Exception as e:
            logger.error("Tray quit failed: %s", e)

    menu = pystray.Menu(
        Item("显示组件", show, default=True),
        Item("隐藏组件", hide),
        Item("打开 WebUI", open_webui),
        Item("退出", quit_app),
    )
    icon = pystray.Icon("qBitWidget", _make_tray_image(), "qBitWidget", menu)
    api._tray_icon = icon

    # run_detached avoids fighting the WinForms/WebView2 UI thread
    try:
        icon.run_detached()
        logger.info("System tray icon started")
    except Exception as e:
        logger.error("Tray start failed: %s", e)
        api._tray_icon = None
        return None
    return icon


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
    except Exception:
        pass
    return False


def _single_instance_lock(logger: logging.Logger):
    """Prevent multiple widgets locking WebView2 user-data folder.

    Returns (ok, lock_path). ok=False means another live instance exists.
    """
    lock_path = Path(__file__).parent / ".widget.lock"
    try:
        if lock_path.exists():
            try:
                old_pid = int(lock_path.read_text(encoding="utf-8").strip() or "0")
            except ValueError:
                old_pid = 0
            if _pid_alive(old_pid):
                logger.error("Another widget is already running (pid=%s).", old_pid)
                return False, lock_path
        lock_path.write_text(str(os.getpid()), encoding="utf-8")
        return True, lock_path
    except Exception as e:
        logger.warning("Lock file skipped: %s", e)
        return True, None


def main() -> int:
    config = Config()
    logger = setup_logging(config.debug)

    logger.info("Starting qBitWidget")
    logger.info("Target: %s", config.qb_url)

    ok, lock_path = _single_instance_lock(logger)
    if not ok:
        return 2

    html_path = Path(__file__).parent / "index.html"
    if not html_path.exists():
        logger.error("HTML file not found: %s", html_path)
        return 1

    client = QBittorrentClient(config, logger)
    api = WidgetApi(client, logger)
    api._tray_icon = None

    window = webview.create_window(
        "qBitWidget",
        url=str(html_path),
        width=config.window_width,
        height=config.window_height,
        frameless=True,
        on_top=True,
        easy_drag=True,
        resizable=False,
        hidden=False,
        background_color="#0f0f19",
        js_api=api,
    )
    api.set_window(window)

    ready_once = {"done": False}

    def after_window_ready():
        """Called when page is loaded — WebView2 is fully up."""
        if ready_once["done"]:
            return
        ready_once["done"] = True
        logger.info("Window loaded — enabling tray / taskbar hide")
        try:
            # Make sure visible first
            window.show()
        except Exception:
            pass
        # Small delay so first paint finishes before mutating form flags
        def late():
            time.sleep(0.8)
            try:
                _hide_from_taskbar(logger)
            except Exception as e:
                logger.debug("taskbar hide: %s", e)
            try:
                _start_tray(api, window, logger)
            except Exception as e:
                logger.error("tray: %s", e)
        threading.Thread(target=late, daemon=True, name="tray-late").start()

    try:
        window.events.loaded += after_window_ready
    except Exception:
        pass

    threading.Thread(
        target=update_loop,
        args=(api, window, config, logger),
        daemon=True,
    ).start()

    try:
        # Do NOT run tray/taskbar logic in webview.start func — that races WebView2 init
        webview.start(debug=config.debug)
    except KeyboardInterrupt:
        logger.info("Shutdown requested")
    finally:
        tray = getattr(api, "_tray_icon", None)
        if tray is not None:
            try:
                tray.stop()
            except Exception:
                pass
        if lock_path is not None:
            try:
                lock_path.unlink(missing_ok=True)
            except Exception:
                pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
