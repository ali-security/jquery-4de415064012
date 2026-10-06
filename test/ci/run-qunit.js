#!/usr/bin/env node
/*
 * Headless-Chrome runner for the jQuery QUnit (1.14) browser suite.
 *
 * Usage: node run-qunit.js [url]
 *   url defaults to http://localhost:8000/test/index.html
 *
 * The page must be served by PHP (php -S) from the repository root so the
 * ajax tests can reach test/data/*.php.
 *
 * Exit code: 0 when every test passed, 1 on any failed test, zero tests,
 * a page crash, when no QUnit report arrives for STALL_TIMEOUT_MS (a hung
 * test), or when QUnit.done never fires within GLOBAL_TIMEOUT_MS.
 *
 * Browser: puppeteer 2.0.0 and its bundled Chromium 79 (r706915), on purpose.
 * "ajax :: #14379 - jQuery.ajax() on unload" issues a synchronous XHR from an
 * unload handler; Chromium rejects that ("Synchronous XHR in page
 * dismissal") and since Chrome 88 there is no flag or policy left to allow it
 * (Chrome 121 has neither ForbidSyncXHRInPageDismissal nor
 * AllowSyncXHRInPageDismissal), so a newer Chrome cannot pass that test.
 */
"use strict";

var puppeteer = require( "puppeteer" );

var url = process.argv[ 2 ] || "http://localhost:8000/test/index.html";
var GLOBAL_TIMEOUT_MS = 20 * 60 * 1000;
var STALL_TIMEOUT_MS = 5 * 60 * 1000;
var NAVIGATION_RETRIES = 30;

var stats = {
	testsPassed: 0,
	testsFailed: 0,
	failedAssertions: {}
};

var browser = null;
var finished = false;
var lastReportAt = Date.now();
var currentTest = null;

function log( line ) {
	process.stdout.write( line + "\n" );
}

async function finish( code, message ) {
	if ( finished ) {
		return;
	}
	finished = true;
	if ( message ) {
		log( message );
	}
	try {
		if ( browser ) {
			await browser.close();
		}
	} catch ( e ) {
		log( "WARN failed to close browser: " + e.message );
	}
	process.exit( code );
}

function testKey( module, name ) {
	return ( module || "" ) + " :: " + ( name || "" );
}

function handleEvent( type, data ) {
	var key, failures, i;

	if ( finished ) {
		return;
	}
	lastReportAt = Date.now();

	if ( type === "testStart" ) {
		currentTest = testKey( data.module, data.name );

	} else if ( type === "log" ) {
		// Only failed assertions are reported; keep them until testDone
		key = testKey( data.module, data.name );
		( stats.failedAssertions[ key ] = stats.failedAssertions[ key ] || [] ).push( data );

	} else if ( type === "testDone" ) {
		key = testKey( data.module, data.name );
		currentTest = null;
		failures = stats.failedAssertions[ key ] || [];
		delete stats.failedAssertions[ key ];

		if ( data.failed > 0 ) {
			stats.testsFailed++;
			log( "FAIL " + key + " (" + data.failed + " failed of " + data.total + ")" );
			for ( i = 0; i < failures.length; i++ ) {
				log( "    - message:  " + failures[ i ].message );
				if ( failures[ i ].hasExpected ) {
					log( "      expected: " + failures[ i ].expected );
					log( "      actual:   " + failures[ i ].actual );
				} else if ( failures[ i ].actual !== undefined ) {
					log( "      actual:   " + failures[ i ].actual );
				}
				if ( failures[ i ].source ) {
					log( "      source:   " + failures[ i ].source.split( "\n" ).join( "\n                " ) );
				}
			}
		} else {
			stats.testsPassed++;
			log( "PASS " + key + " (" + data.passed + "/" + data.total + ")" );
		}

	} else if ( type === "done" ) {
		log( "" );
		log( "QUnit summary: " + stats.testsPassed + " tests passed, " +
			stats.testsFailed + " tests failed; assertions: " +
			data.passed + " passed, " + data.failed + " failed, " +
			data.total + " total; runtime " + data.runtime + "ms" );

		if ( stats.testsPassed + stats.testsFailed === 0 ) {
			finish( 1, "ERROR: zero tests ran" );
		} else if ( stats.testsFailed > 0 || data.failed > 0 ) {
			finish( 1 );
		} else {
			finish( 0 );
		}

	} else if ( type === "hooked" ) {
		log( "QUnit hook installed (" + data.via + ")" );

	} else if ( type === "deferred" ) {
		log( "Deferred " + data.what );
	}
}

// Runs inside the page (every frame) before any page script.
function installHook() {
	// Only the top-level test page; iframes used by the tests are ignored.
	if ( window.top !== window ) {
		return;
	}

	var hooked = false;
	var windowLoaded = false;
	var MAX_LEN = 2000;

	// Registered before any page script, so it runs before QUnit's own
	// window load handler (QUnit.load)
	window.addEventListener( "load", function() {
		windowLoaded = true;
	});

	function report( type, data ) {
		try {
			window.__qunitReport( type, JSON.stringify( data ) );
		} catch ( e ) {}
	}

	function dump( QUnit, value ) {
		var str;
		try {
			str = QUnit.jsDump && QUnit.jsDump.parse ? QUnit.jsDump.parse( value ) : String( value );
		} catch ( e ) {
			try {
				str = String( value );
			} catch ( e2 ) {
				str = "<unserializable>";
			}
		}
		if ( typeof str === "string" && str.length > MAX_LEN ) {
			str = str.slice( 0, MAX_LEN ) + "... (truncated)";
		}
		return str;
	}

	function hook( QUnit, via ) {
		if ( hooked || !QUnit || typeof QUnit.log !== "function" ||
				typeof QUnit.testDone !== "function" || typeof QUnit.done !== "function" ) {
			return;
		}
		hooked = true;

		// Do not let the run start before the window "load" event.
		// QUnit registers QUnit.load as a window load handler, and
		// test/data/testinit.js loadTests() also calls QUnit.load() + QUnit.start()
		// once every unit/*.js file is required. QUnit.load() -> QUnit.init()
		// rewrites #qunit, wiping the result <li> of the test in progress, so
		// when "load" is late (a slow subresource, e.g. on a busy CI box) the
		// next finish() throws a TypeError setting "className" of null inside
		// QUnit's queue and the suite hangs forever.
		// Async tests call the global start(), which QUnit copied onto window
		// before this hook runs, and once "load" has fired the wrapper is a
		// plain pass-through.
		var originalStart = QUnit.start;
		QUnit.start = function() {
			var self = this,
				args = arguments;
			if ( windowLoaded ) {
				return originalStart.apply( self, args );
			}
			report( "deferred", { what: "QUnit.start() until window load" } );
			window.addEventListener( "load", function() {
				// After QUnit's own load handler (registered earlier) has run
				setTimeout(function() {
					originalStart.apply( self, args );
				}, 0 );
			});
		};

		// QUnit 1.14: QUnit.log/testDone/done are registerLoggingCallback()s
		// that push onto config[ key ], so these are additive to the suite's
		// own callbacks (testrunner.js registers its own testDone/done).
		QUnit.testStart(function( details ) {
			report( "testStart", {
				module: details.module,
				name: details.name
			});
		});
		QUnit.log(function( details ) {
			if ( details.result ) {
				return;
			}
			report( "log", {
				module: details.module,
				name: details.name,
				message: details.message === undefined ? "(no message)" : String( details.message ),
				hasExpected: Object.prototype.hasOwnProperty.call( details, "expected" ),
				expected: dump( QUnit, details.expected ),
				actual: Object.prototype.hasOwnProperty.call( details, "actual" ) ?
					dump( QUnit, details.actual ) : undefined,
				source: details.source ? String( details.source ) : undefined
			});
		});
		QUnit.testDone(function( details ) {
			report( "testDone", {
				module: details.module,
				name: details.name,
				failed: details.failed,
				passed: details.passed,
				total: details.total,
				runtime: details.runtime
			});
		});
		QUnit.done(function( details ) {
			report( "done", {
				failed: details.failed,
				passed: details.passed,
				total: details.total,
				runtime: details.runtime
			});
		});
		report( "hooked", { via: via } );
	}

	// QUnit 1.14 ends with:
	//   extend( window, QUnit.constructor.prototype );
	//   window.QUnit = QUnit;
	// By then QUnit.log/testDone/done and QUnit.config exist, so a setter on
	// window.QUnit fires with a fully-initialised object.
	var current;
	try {
		Object.defineProperty( window, "QUnit", {
			configurable: true,
			enumerable: true,
			get: function() {
				return current;
			},
			set: function( value ) {
				current = value;
				hook( value, "window.QUnit setter" );
			}
		});
	} catch ( e ) {}

	// Fallback in case the setter was bypassed: poll until QUnit shows up.
	// Tests cannot start before the page's own (async) loadTests() runs.
	var poll = setInterval(function() {
		if ( hooked ) {
			clearInterval( poll );
		} else if ( window.QUnit && window.QUnit.config ) {
			hook( window.QUnit, "polling fallback" );
			clearInterval( poll );
		}
	}, 10 );
}

function sleep( ms ) {
	return new Promise(function( resolve ) {
		setTimeout( resolve, ms );
	});
}

async function main() {
	var timer = setTimeout(function() {
		finish( 1, "ERROR: QUnit.done did not fire within " + ( GLOBAL_TIMEOUT_MS / 60000 ) +
			" minutes (" + stats.testsPassed + " passed, " + stats.testsFailed +
			" failed so far)" );
	}, GLOBAL_TIMEOUT_MS );

	// Fail fast with a message on a hung test instead of waiting for the CI's
	// own no-output kill (QUnit's testTimeout cannot fire once its queue died).
	setInterval(function() {
		if ( Date.now() - lastReportAt >= STALL_TIMEOUT_MS ) {
			finish( 1, "ERROR: no QUnit report for " + ( STALL_TIMEOUT_MS / 60000 ) +
				" minutes; current test: " + ( currentTest || "(none running)" ) +
				" (" + stats.testsPassed + " passed, " + stats.testsFailed + " failed so far)" );
		}
	}, 10000 );

	browser = await puppeteer.launch({
		headless: true,
		args: [ "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
			// Chromium 79 already rejects synchronous XHR during page dismissal
			// (unload); this feature (backing the AllowSyncXHRInPageDismissal
			// policy, removed in Chrome 88) re-allows it for
			// "ajax :: #14379 - jQuery.ajax() on unload".
			"--enable-features=AllowSyncXHRInPageDismissal" ]
	});
	log( "Browser: " + await browser.version() );

	var page = await browser.newPage();
	page.setDefaultNavigationTimeout( 120000 );

	// A headless page never has OS focus, so native focus/blur/focusin/focusout
	// would not fire; emulate focus so the event-order tests can run.
	var client = await page.target().createCDPSession();
	await client.send( "Emulation.setFocusEmulationEnabled", { enabled: true } );

	await page.exposeFunction( "__qunitReport", function( type, json ) {
		var data;
		try {
			data = JSON.parse( json );
		} catch ( e ) {
			log( "WARN bad report payload for " + type + ": " + e.message );
			return;
		}
		handleEvent( type, data );
	});

	await page.evaluateOnNewDocument( installHook );

	page.on( "console", function( msg ) {
		var type = msg.type();
		if ( type === "error" || type === "warning" || type === "warn" ) {
			log( "[console." + type + "] " + msg.text() );
		}
	});
	page.on( "pageerror", function( err ) {
		log( "[pageerror] " + ( err && err.message ? err.message : err ) );
	});
	page.on( "dialog", function( dialog ) {
		log( "[dialog " + dialog.type() + "] " + dialog.message() );
		dialog.dismiss().catch(function() {});
	});
	page.on( "error", function( err ) {
		finish( 1, "ERROR: page crashed: " + ( err && err.message ? err.message : err ) );
	});

	// The PHP server is started in the background just before this script;
	// retry while it is still coming up.
	for ( var attempt = 1; ; attempt++ ) {
		try {
			log( "Opening " + url + " (attempt " + attempt + ")" );
			await page.goto( url, { waitUntil: "load" } );
			break;
		} catch ( e ) {
			if ( finished ) {
				return;
			}
			if ( attempt >= NAVIGATION_RETRIES || !/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/.test( e.message ) ) {
				return finish( 1, "ERROR: could not load " + url + ": " + e.message );
			}
			await sleep( 1000 );
		}
	}
	// From here the process stays alive until done/timeout calls finish().
}

process.on( "unhandledRejection", function( err ) {
	finish( 1, "ERROR: " + ( err && err.stack ? err.stack : err ) );
});

main().catch(function( err ) {
	finish( 1, "ERROR: " + ( err && err.stack ? err.stack : err ) );
});
