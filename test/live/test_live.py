"""Checks of the live harness without Chromium or a display."""

import tempfile
import unittest
from unittest.mock import Mock, patch

import live
import server


class LiveChecks(unittest.TestCase):
    def test_hold_requires_the_frame_request_after_release(self):
        # Exercise the real trial collection and final check. Only the external
        # bridge, request log, clock and result file are stand-ins.
        for frame_ts, page, request, expected in (
            (None, True, True, False),
            (99.0, True, True, False),
            (100.0, True, True, True),
            (101.0, True, True, True),
            (101.0, False, True, False),
            (101.0, True, False, False),
        ):
            with self.subTest(frame_ts=frame_ts, page=page, request=request), tempfile.TemporaryDirectory() as run:
                driver = live.Live.__new__(live.Live)
                driver.run, driver.port = run, 8771
                driver.r = live.Results(run)
                driver.ctl = Mock()
                driver.ctl.mark.return_value = 0
                driver.ctl.events.return_value = []

                def wait(since, timeout, **match):
                    if match["kind"] == "bridge-ev":
                        if match.get("method") == "Fetch.requestPaused":
                            return None
                        return {"ts": 98.0, "tab": 1, "attached": True, "held": True}
                    if match["kind"] == "page":
                        return {"ts": 101.0} if page else None
                    if match.get("path", "").startswith("/f/"):
                        return {"ts": frame_ts} if frame_ts is not None else None
                    return {"ts": 101.0} if request else None

                driver.ctl.wait.side_effect = wait
                driver.new_tab = Mock(return_value=1)
                driver.bridge = Mock(return_value={"ok": True, "data": None})
                driver.cdp = Mock()
                driver.close_tab = Mock()
                with patch.object(live.time, "time", return_value=100.0), patch.object(live.time, "sleep"), \
                        patch.dict(live.os.environ, {"HOLD_TRIALS": "1"}), patch("builtins.print"):
                    driver.hold()
                row = next(r for r in driver.r.rows if r["case"].startswith("a page with a frame,"))
                self.assertEqual(row["result"], "pass" if expected else "FAIL")

    def test_operator_list_requires_a_block_and_no_scoped_request(self):
        for loaded, blocked, requests, expected in (
            (True, True, [], True),
            (False, True, [], False),
            (True, False, [], False),
            (True, True, [{"kind": "req", "path": "/p/operator-list-scoped"}], False),
        ):
            with self.subTest(loaded=loaded, blocked=blocked, requests=requests), tempfile.TemporaryDirectory() as run:
                driver = live.Live.__new__(live.Live)
                driver.run, driver.port = run, 8771
                driver.r = live.Results(run)
                driver.agent = Mock()
                driver.ctl = Mock()
                driver.ctl.mark.return_value = 0
                driver.ctl.wait.side_effect = [
                    {"kind": "page", "page_kind": "page-load", "page": "/p/operator-list-marked",
                     "host": "www.operator-only.localhost"} if loaded else None,
                    {"kind": "blocked", "host": "www.operator-only.localhost", "tab": 1} if blocked else None,
                ]
                driver.ctl.events.return_value = requests
                driver.new_tab = Mock(return_value=1)
                driver.cdp = Mock()
                driver.close_tab = Mock()
                with patch("builtins.print"):
                    driver.operator_list()
                self.assertEqual(driver.r.rows[0]["result"], "pass" if expected else "FAIL")

    def test_daemon_gives_operator_tabs_a_distinct_list(self):
        daemon = server.StubDaemon("unused", Mock())
        # Capture the message at the wire boundary; set_scopes builds it itself.
        daemon.request = lambda op, **fields: {"op": op, **fields}
        msg = daemon.set_scopes(["s1.localhost"])
        scope_list = msg["scopes"][live.SCOPE]
        operator_list = msg["operator"]
        self.assertNotEqual(operator_list, scope_list)
        self.assertEqual(msg["default"], scope_list)
        self.assertEqual(msg["lists"][scope_list], ["s1.localhost"])
        self.assertEqual(msg["lists"][operator_list], ["operator-only.localhost", "s1.localhost"])


if __name__ == "__main__":
    unittest.main()
