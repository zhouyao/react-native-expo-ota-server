import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { logger, reportError } from '../logger';
import { colors, radius, spacing } from '../theme';

/**
 * 渲染期错误边界：捕获子树抛出的异常，上报后展示兜底页。
 * 「重试」会重置边界并触发 onReset（由外层换 key 重新挂载子树）。
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleReset = this.handleReset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    void reportError(error, {
      source: 'render',
      componentStack: info?.componentStack,
    });
  }

  handleReset() {
    this.setState({ error: null });
    if (typeof this.props.onReset === 'function') this.props.onReset();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const logs = logger
      .getEntries()
      .slice(-6)
      .map((entry) => `${entry.level.toUpperCase()} ${entry.message}`)
      .join('\n');

    return (
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.card}>
          <Text style={styles.title}>页面出错了</Text>
          <Text style={styles.hint}>
            错误已记录并尝试上报到 OTA 服务端（看板「事件」中的 client-error）。
          </Text>
          <Text style={styles.error} selectable>
            {`${error.name || 'Error'}: ${error.message}`}
          </Text>
          {logs ? (
            <>
              <Text style={styles.sectionTitle}>最近日志</Text>
              <Text style={styles.logs} selectable>
                {logs}
              </Text>
            </>
          ) : null}
          <Pressable style={styles.button} onPress={this.handleReset}>
            <Text style={styles.buttonText}>重试</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  page: {
    flexGrow: 1,
    padding: spacing.page,
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: spacing.card,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
  },
  hint: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
  error: {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    backgroundColor: colors.dangerSoft,
    color: colors.danger,
    fontSize: 12,
    lineHeight: 18,
  },
  sectionTitle: {
    marginTop: 14,
    fontSize: 12,
    fontWeight: '600',
    color: colors.text,
  },
  logs: {
    marginTop: 6,
    padding: 10,
    borderRadius: 8,
    backgroundColor: colors.bg,
    color: colors.muted,
    fontSize: 11,
    lineHeight: 16,
  },
  button: {
    marginTop: 16,
    alignSelf: 'flex-start',
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: radius.button,
    backgroundColor: colors.primary,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
