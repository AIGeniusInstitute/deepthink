// S1 spike：libnode 嵌入式启动胶水（改造自 @flun/nodejs-mobile-react-native 的 native-lib.cpp，
// 去掉 rn-bridge 消息桥，仅保留 node::Start + stdout/stderr→logcat）。
#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

#include "node.h"

#define APPNAME "DTNODE"

extern "C" int callintoNode(int argc, char *argv[]) {
    return node::Start(argc, argv);
}

// ── stdout/stderr → logcat ─────────────────────────────────────
int pipe_stdout[2];
int pipe_stderr[2];

void *thread_stderr_func(void *) {
    ssize_t n;
    char buf[2048];
    while ((n = read(pipe_stderr[0], buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(ANDROID_LOG_ERROR, APPNAME, buf);
    }
    return 0;
}

void *thread_stdout_func(void *) {
    ssize_t n;
    char buf[2048];
    while ((n = read(pipe_stdout[0], buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(ANDROID_LOG_INFO, APPNAME, buf);
    }
    return 0;
}

int start_redirecting_stdout_stderr() {
    setvbuf(stdout, 0, _IONBF, 0);
    pipe(pipe_stdout);
    dup2(pipe_stdout[1], STDOUT_FILENO);

    setvbuf(stderr, 0, _IONBF, 0);
    pipe(pipe_stderr);
    dup2(pipe_stderr[1], STDERR_FILENO);

    pthread_t t1, t2;
    if (pthread_create(&t1, 0, thread_stdout_func, 0) == -1) return -1;
    pthread_detach(t1);
    if (pthread_create(&t2, 0, thread_stderr_func, 0) == -1) return -1;
    pthread_detach(t2);
    return 0;
}

// ── JNI 入口：等价于 node 的 CLI 启动（node::Start） ─────────────
extern "C" JNIEXPORT jint JNICALL
Java_com_aigeniusinstitute_deepthink_spike_Dtnode_startNodeWithArguments(
        JNIEnv *env,
        jobject /* this */,
        jobjectArray arguments,
        jstring modulesPath,
        jboolean option_redirectOutputToLogcat) {

    const char *path_path = env->GetStringUTFChars(modulesPath, 0);
    setenv("NODE_PATH", path_path, 1);
    env->ReleaseStringUTFChars(modulesPath, path_path);

    jsize argument_count = env->GetArrayLength(arguments);

    int c_arguments_size = 0;
    for (int i = 0; i < argument_count; i++) {
        c_arguments_size += strlen(env->GetStringUTFChars((jstring) env->GetObjectArrayElement(arguments, i), 0));
        c_arguments_size++;
    }

    char *args_buffer = (char *) calloc(c_arguments_size, sizeof(char));
    char *argv[argument_count];
    char *current_args_position = args_buffer;

    for (int i = 0; i < argument_count; i++) {
        const char *current_argument = env->GetStringUTFChars((jstring) env->GetObjectArrayElement(arguments, i), 0);
        strncpy(current_args_position, current_argument, strlen(current_argument));
        argv[i] = current_args_position;
        current_args_position += strlen(current_args_position) + 1;
    }

    if (option_redirectOutputToLogcat) {
        if (start_redirecting_stdout_stderr() == -1) {
            __android_log_write(ANDROID_LOG_ERROR, APPNAME, "Couldn't start redirecting stdout and stderr to logcat.");
        }
    }

    return (jint) callintoNode(argument_count, argv);
}
