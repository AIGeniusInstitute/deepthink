package com.aigeniusinstitute.deepthink.spike

import android.app.Activity
import android.os.Bundle
import android.util.Log
import java.io.File

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val work = File(filesDir, "spike").apply { mkdirs() }
        for (name in listOf("main.js", "child.js")) {
            assets.open(name).use { input ->
                File(work, name).outputStream().use { input.copyTo(it) }
            }
        }
        Thread {
            Log.i("DTNODE", "starting node, workdir=${work.absolutePath}")
            val code = Dtnode.startNodeWithArguments(
                arrayOf("node", File(work, "main.js").absolutePath),
                work.absolutePath,
                true
            )
            Log.i("DTNODE", "node exited with code $code")
        }.start()
    }
}

object Dtnode {
    init {
        System.loadLibrary("dtnode")
    }

    external fun startNodeWithArguments(
        arguments: Array<String>,
        modulesPath: String,
        redirectOutputToLogcat: Boolean
    ): Int
}
